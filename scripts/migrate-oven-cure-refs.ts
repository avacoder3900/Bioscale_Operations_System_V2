/**
 * S2 migration — back-fill canonical Equipment._id on every CartridgeRecord
 * with `ovenCure.locationId` set. Pre-S2 writers wrote raw form input
 * (barcode | name | _id depending on caller) to the authoritative field.
 *
 * Per PRD Equipment Connectivity v2 §S2.
 *
 * Usage:
 *   npx tsx scripts/migrate-oven-cure-refs.ts --plan
 *   npx tsx scripts/migrate-oven-cure-refs.ts --apply
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
if (!MODE) { console.error('Usage: --plan or --apply'); process.exit(1); }

const OPERATOR = 'system-migrate-oven-cure-2026-04-24';

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const carts = db.collection('cartridge_records');
	const equip = db.collection('equipment');

	const ovens = await equip.find({ equipmentType: 'oven' }).project({ _id: 1, name: 1, barcode: 1 }).toArray() as any[];
	const map = new Map<string, string>();
	for (const o of ovens) {
		const id = String(o._id);
		map.set(id, id);
		if (o.barcode) map.set(String(o.barcode), id);
		if (o.name) map.set(String(o.name), id);
	}
	console.log(`Resolver: ${ovens.length} ovens, ${map.size} keys.`);

	const candidates = await carts.find({
		'ovenCure.locationId': { $exists: true, $ne: null }
	}).project({ _id: 1, 'ovenCure.locationId': 1, 'ovenCure.locationName': 1, finalizedAt: 1 }).toArray() as any[];

	let normalized = 0, alreadyOk = 0, unresolved: Array<{ _id: string; value: string }> = [];
	let skippedFinalized = 0;
	for (const c of candidates) {
		const value = String(c.ovenCure?.locationId ?? '');
		const equipmentId = map.get(value);
		if (!equipmentId) { unresolved.push({ _id: c._id, value }); continue; }
		if (value === equipmentId) { alreadyOk++; continue; }
		if (c.finalizedAt) { skippedFinalized++; continue; }
		if (MODE === 'apply') {
			// Look up canonical name to refresh the snapshot
			const ovenDoc = ovens.find((o: any) => String(o._id) === equipmentId);
			const canonicalName = ovenDoc?.name ?? ovenDoc?.barcode ?? value;
			await carts.updateOne({ _id: c._id }, {
				$set: {
					'ovenCure.locationId': equipmentId,
					'ovenCure.locationName': canonicalName
				}
			});
		}
		normalized++;
	}

	console.log(`\n=== ${MODE.toUpperCase()} ===`);
	console.log(`already canonical:    ${alreadyOk}`);
	console.log(`normalized:           ${normalized}`);
	console.log(`skipped finalized:    ${skippedFinalized}`);
	console.log(`unresolvable:         ${unresolved.length}`);
	for (const u of unresolved.slice(0, 10)) console.log(`  ${u._id}  loc="${u.value}"`);

	if (MODE === 'apply') {
		await db.collection('audit_logs').insertOne({
			_id: generateId(),
			tableName: 'cartridge_records',
			recordId: 'migration-oven-cure-2026-04-24',
			action: 'MIGRATION_OVEN_CURE_LOCATION_ID',
			changedBy: OPERATOR,
			changedAt: new Date(),
			newData: { normalized, alreadyOk, skippedFinalized, unresolvedCount: unresolved.length, unresolvedSample: unresolved.slice(0, 50) }
		});
		console.log('\nAudit log written.');
	}

	await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
