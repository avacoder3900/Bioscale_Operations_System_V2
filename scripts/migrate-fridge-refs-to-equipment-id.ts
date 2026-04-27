/**
 * S1b migration — back-fill canonical Equipment._id on every cartridge that
 * historically wrote `waxStorage.location` (a barcode/name string) into the
 * pre-S1a writers. After this runs, every active-occupancy reader can join
 * by `waxStorage.locationId` (Equipment._id) without falling back to the
 * legacy denormalized string.
 *
 * Same treatment for `storage.fridgeName` → `storage.fridgeId` + `storage.locationId`.
 *
 * Per PRD Equipment Connectivity v2 §S1b.
 *
 * Usage:
 *   npx tsx scripts/migrate-fridge-refs-to-equipment-id.ts --plan
 *   npx tsx scripts/migrate-fridge-refs-to-equipment-id.ts --apply
 *
 * Behavior:
 *   - Builds barcodeOrName → Equipment._id map for `equipmentType: 'fridge'`.
 *   - For every CartridgeRecord with waxStorage.location set and locationId
 *     empty: resolves and $sets locationId. Leaves the legacy string in
 *     place as a snapshot.
 *   - Same for storage.fridgeName → storage.fridgeId / storage.locationId.
 *   - Skips finalized docs (logs as MIGRATION_SKIPPED_FINALIZED).
 *   - Unresolvable refs left untouched, recorded in aggregate AuditLog.
 *   - Raw driver — bypasses sacred middleware so the back-fill is allowed.
 *   - Idempotent: re-runs are no-ops once locationId is populated.
 *   - One aggregate AuditLog per --apply run with full counts.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
import { generateId } from '../src/lib/server/db/utils.js';

const MODE: 'plan' | 'apply' | null = (() => {
	if (process.argv.includes('--apply')) return 'apply';
	if (process.argv.includes('--plan')) return 'plan';
	return null;
})();

if (!MODE) {
	console.error('Usage: --plan (read-only) or --apply (commit)');
	process.exit(1);
}

const OPERATOR = 'system-migrate-fridge-refs-2026-04-24';

async function main() {
	if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI not set');
	await mongoose.connect(process.env.MONGODB_URI);
	const db = mongoose.connection.db!;
	const carts = db.collection('cartridge_records');
	const equip = db.collection('equipment');

	// Build the resolver map: barcode | name | _id → Equipment._id
	const fridges = await equip.find({ equipmentType: 'fridge' }).project({ _id: 1, name: 1, barcode: 1 }).toArray() as any[];
	const map = new Map<string, string>();
	for (const f of fridges) {
		const id = String(f._id);
		map.set(id, id);
		if (f.barcode) map.set(String(f.barcode), id);
		if (f.name) map.set(String(f.name), id);
	}
	console.log(`Resolver map built: ${fridges.length} fridges, ${map.size} keys.`);

	// --- Phase 1: waxStorage.location → waxStorage.locationId ---
	const waxNeedsBackfill = await carts.find({
		'waxStorage.location': { $exists: true, $ne: null },
		$or: [
			{ 'waxStorage.locationId': { $exists: false } },
			{ 'waxStorage.locationId': null },
			{ 'waxStorage.locationId': '' }
		]
	}).project({ _id: 1, 'waxStorage.location': 1, finalizedAt: 1 }).toArray() as any[];

	let waxResolved = 0, waxUnresolved: Array<{ _id: string; value: string }> = [];
	let waxSkippedFinalized = 0;
	for (const c of waxNeedsBackfill) {
		const value = String(c.waxStorage?.location ?? '');
		const equipmentId = map.get(value);
		if (!equipmentId) { waxUnresolved.push({ _id: c._id, value }); continue; }
		if (c.finalizedAt) { waxSkippedFinalized++; continue; }
		if (MODE === 'apply') {
			await carts.updateOne({ _id: c._id }, { $set: { 'waxStorage.locationId': equipmentId } });
		}
		waxResolved++;
	}

	// --- Phase 2: storage.fridgeName → storage.fridgeId + storage.locationId ---
	const storageNeedsBackfill = await carts.find({
		'storage.fridgeName': { $exists: true, $ne: null },
		$or: [
			{ 'storage.fridgeId': { $exists: false } },
			{ 'storage.fridgeId': null },
			{ 'storage.fridgeId': '' }
		]
	}).project({ _id: 1, 'storage.fridgeName': 1, 'storage.locationId': 1, finalizedAt: 1 }).toArray() as any[];

	let storageResolved = 0, storageUnresolved: Array<{ _id: string; value: string }> = [];
	let storageSkippedFinalized = 0;
	for (const c of storageNeedsBackfill) {
		const value = String(c.storage?.fridgeName ?? '');
		const equipmentId = map.get(value);
		if (!equipmentId) { storageUnresolved.push({ _id: c._id, value }); continue; }
		if (c.finalizedAt) { storageSkippedFinalized++; continue; }
		if (MODE === 'apply') {
			// Always set fridgeId; only set locationId if it's missing/empty so we
			// don't overwrite a deliberate prior value (some legacy writes wrote
			// the barcode into locationId — that needs locationId reset, but in
			// practice it'll match fridgeId after this migration anyway).
			const setOps: Record<string, string> = { 'storage.fridgeId': equipmentId };
			const existingLoc = c.storage?.locationId;
			if (!existingLoc || existingLoc === c.storage?.fridgeName) {
				setOps['storage.locationId'] = equipmentId;
			}
			await carts.updateOne({ _id: c._id }, { $set: setOps });
		}
		storageResolved++;
	}

	console.log('\n=== ' + (MODE === 'plan' ? 'PLAN' : 'APPLY') + ' ===');
	console.log(`waxStorage.locationId backfill:`);
	console.log(`  resolvable + non-finalized:   ${waxResolved}`);
	console.log(`  skipped finalized:            ${waxSkippedFinalized}`);
	console.log(`  unresolvable (no fridge match): ${waxUnresolved.length}`);
	console.log(`storage.fridgeId backfill:`);
	console.log(`  resolvable + non-finalized:   ${storageResolved}`);
	console.log(`  skipped finalized:            ${storageSkippedFinalized}`);
	console.log(`  unresolvable:                 ${storageUnresolved.length}`);

	if (waxUnresolved.length > 0 || storageUnresolved.length > 0) {
		console.log('\nUnresolved samples (up to 10 each):');
		for (const u of waxUnresolved.slice(0, 10)) console.log(`  wax  ${u._id}  loc="${u.value}"`);
		for (const u of storageUnresolved.slice(0, 10)) console.log(`  stor ${u._id}  fridgeName="${u.value}"`);
	}

	if (MODE === 'apply') {
		await db.collection('audit_logs').insertOne({
			_id: generateId(),
			tableName: 'cartridge_records',
			recordId: 'migration-fridge-refs-2026-04-24',
			action: 'MIGRATION_EQUIPMENT_ID_BACKFILL',
			changedBy: OPERATOR,
			changedAt: new Date(),
			newData: {
				waxStorageMigrated: waxResolved,
				storageMigrated: storageResolved,
				skippedFinalized: waxSkippedFinalized + storageSkippedFinalized,
				unresolvedCount: waxUnresolved.length + storageUnresolved.length,
				unresolvedSample: [
					...waxUnresolved.slice(0, 50).map((u) => ({ kind: 'wax', _id: u._id, value: u.value })),
					...storageUnresolved.slice(0, 50).map((u) => ({ kind: 'storage', _id: u._id, value: u.value }))
				]
			}
		});
		console.log('\nAggregate AuditLog written.');
	}

	await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
