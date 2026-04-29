/**
 * End-to-end connectivity check for the 30 checked-out cartridges.
 *
 *  1. Current CartridgeRecord shape (status, voided*, waxStorage, storage).
 *  2. FRIDGE-002 occupancy — do any of the 30 still show up?
 *  3. ManualCartridgeRemoval docs — 1:1 with cartridgeIds, correct fields.
 *  4. InventoryTransactions — confirm all scrap txns for these IDs are retracted.
 *  5. AuditLog entries — backfill + revert + removal CHECKOUT present.
 *  6. Any OTHER collection referencing these IDs as active inventory?
 */
import fs from 'node:fs';
import path from 'node:path';
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const ids = Array.from(new Set(
		fs.readFileSync(path.resolve('scripts/data/manual-removal-backfill-2026-04-23.txt'), 'utf8')
			.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
	));
	console.log(`Target IDs: ${ids.length} unique`);
	const idSet = new Set(ids);

	console.log('\n' + '='.repeat(72));
	console.log(' 1. CartridgeRecord current state');
	console.log('='.repeat(72));
	const carts = await db.collection('cartridge_records').find({ _id: { $in: ids } }).toArray() as any[];
	console.log(`found: ${carts.length}/${ids.length}`);
	const byStatus: Record<string, number> = {};
	const voidedSet: string[] = [];
	const waxStorageSet: string[] = [];
	const storageSet: string[] = [];
	for (const c of carts) {
		byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;
		if (c.voidedAt || c.voidReason) voidedSet.push(c._id);
		if (c.waxStorage?.location) waxStorageSet.push(`${c._id} -> ${c.waxStorage.location}`);
		if (c.storage?.locationId || c.storage?.fridgeName) storageSet.push(`${c._id} -> ${c.storage?.fridgeName ?? c.storage?.locationId}`);
	}
	console.log('  status distribution:');
	for (const [s, n] of Object.entries(byStatus)) console.log(`    ${s}: ${n}`);
	console.log(`  with voidedAt/voidReason still set: ${voidedSet.length}`);
	for (const v of voidedSet) console.log(`    ${v}`);
	console.log(`  with waxStorage.location still set: ${waxStorageSet.length}`);
	for (const v of waxStorageSet) console.log(`    ${v}`);
	console.log(`  with storage.* still set: ${storageSet.length}`);
	for (const v of storageSet) console.log(`    ${v}`);

	console.log('\n' + '='.repeat(72));
	console.log(' 2. FRIDGE-002 occupancy check');
	console.log('='.repeat(72));
	// The fridge-storage page query pattern: { 'waxStorage.location': {$exists, $ne:null}, status:'wax_stored' }
	const fridge002Occupants = await db.collection('cartridge_records').find({
		'waxStorage.location': 'FRIDGE-002',
		status: 'wax_stored'
	}).project({ _id: 1 }).toArray() as any[];
	console.log(`FRIDGE-002 active wax_stored occupants: ${fridge002Occupants.length}`);
	const overlap = fridge002Occupants.filter((c) => idSet.has(c._id));
	console.log(`  overlap with our 30 checkouts: ${overlap.length} (should be 0)`);
	for (const c of overlap) console.log(`    LEAKED: ${c._id}`);

	// Also check: any of the 30 that EVER referenced FRIDGE-002?
	const evenEver = await db.collection('cartridge_records').find({
		_id: { $in: ids },
		$or: [
			{ 'waxStorage.location': /FRIDGE/i },
			{ 'storage.fridgeName': /FRIDGE/i },
			{ 'storage.fridgeId': /FRIDGE/i },
			{ 'storage.locationId': /FRIDGE/i }
		]
	}).project({ _id: 1, waxStorage: 1, storage: 1 }).toArray();
	console.log(`  of the 30, any with fridge references anywhere: ${evenEver.length}`);
	for (const c of evenEver as any[]) console.log(`    ${c._id}  waxStorage=${JSON.stringify(c.waxStorage ?? {})}  storage=${JSON.stringify(c.storage ?? {})}`);

	console.log('\n' + '='.repeat(72));
	console.log(' 3. ManualCartridgeRemoval docs — 1:1 with cartridgeIds');
	console.log('='.repeat(72));
	const removals = await db.collection('manual_cartridge_removals').find({
		cartridgeIds: { $in: ids }
	}).toArray() as any[];
	console.log(`matching removal docs: ${removals.length}`);
	const perCartCount = new Map<string, number>();
	for (const r of removals) {
		for (const cid of r.cartridgeIds ?? []) {
			perCartCount.set(cid, (perCartCount.get(cid) ?? 0) + 1);
		}
	}
	const missing = ids.filter((id) => !perCartCount.has(id));
	const multi = [...perCartCount.entries()].filter(([, n]) => n > 1);
	console.log(`  cartridges with 0 removal docs (missing): ${missing.length}`);
	for (const m of missing) console.log(`    ${m}`);
	console.log(`  cartridges with >1 removal docs: ${multi.length}`);
	for (const [cid, n] of multi) console.log(`    ${cid}: ${n}`);
	const sampleRemoval = removals[0];
	if (sampleRemoval) {
		console.log(`  sample doc:`);
		console.log(`    _id=${sampleRemoval._id}  reason="${sampleRemoval.reason}"  removedAt=${sampleRemoval.removedAt?.toISOString?.()}  operator=${sampleRemoval.operator?.username}  cartridgeIds.length=${(sampleRemoval.cartridgeIds ?? []).length}`);
	}

	console.log('\n' + '='.repeat(72));
	console.log(' 4. InventoryTransaction state for these IDs');
	console.log('='.repeat(72));
	const txns = await db.collection('inventory_transactions').find({
		cartridgeRecordId: { $in: ids }
	}).toArray() as any[];
	const byType: Record<string, { live: number; retracted: number }> = {};
	for (const t of txns) {
		const k = t.transactionType;
		byType[k] ??= { live: 0, retracted: 0 };
		if (t.retractedAt) byType[k].retracted++; else byType[k].live++;
	}
	for (const [k, v] of Object.entries(byType)) {
		console.log(`  ${k}: live=${v.live}  retracted=${v.retracted}`);
	}
	const liveScrap = txns.filter((t) => t.transactionType === 'scrap' && !t.retractedAt);
	if (liveScrap.length > 0) {
		console.log(`  WARNING: ${liveScrap.length} non-retracted scrap txns still present:`);
		for (const t of liveScrap) console.log(`    ${t._id}  cart=${t.cartridgeRecordId}  at=${t.performedAt?.toISOString?.()}`);
	}

	console.log('\n' + '='.repeat(72));
	console.log(' 5. AuditLog entries for these IDs');
	console.log('='.repeat(72));
	const audits = await db.collection('audit_logs').find({
		tableName: 'cartridge_records',
		recordId: { $in: ids }
	}).sort({ changedAt: 1 }).toArray() as any[];
	const auditByCart: Record<string, any[]> = {};
	for (const a of audits) {
		(auditByCart[a.recordId] ??= []).push(a);
	}
	const byActor: Record<string, number> = {};
	for (const a of audits) byActor[a.changedBy ?? '(null)'] = (byActor[a.changedBy ?? '(null)'] ?? 0) + 1;
	console.log(`  total audit entries touching these 30 cartridges: ${audits.length}`);
	for (const [actor, n] of Object.entries(byActor)) console.log(`    ${actor}: ${n}`);
	// Each of the 30 should have both a backfill UPDATE and a revert UPDATE
	let missingBackfill = 0, missingRevert = 0;
	for (const cid of ids) {
		const entries = auditByCart[cid] ?? [];
		const hasBackfill = entries.some((e) => e.changedBy === 'system-backfill-2026-04-23');
		const hasRevert = entries.some((e) => e.changedBy === 'system-revert-2026-04-23');
		if (!hasBackfill) missingBackfill++;
		if (!hasRevert) missingRevert++;
	}
	console.log(`  cartridges missing backfill audit: ${missingBackfill}`);
	console.log(`  cartridges missing revert audit:   ${missingRevert}`);

	console.log('\n' + '='.repeat(72));
	console.log(' 6. Other collections referencing these IDs');
	console.log('='.repeat(72));
	const otherCollections = [
		{ name: 'backing_lots', field: 'cartridgeIds' },
		{ name: 'wax_filling_runs', field: 'cartridgeIds' },
		{ name: 'reagent_batch_records', field: 'cartridgesFilled.cartridgeId' },
		{ name: 'firmware_cartridges', field: 'cartridgeRecordId' },
		{ name: 'shipping_packages', field: 'cartridgeIds' },
		{ name: 'test_results', field: 'cartridgeId' }
	];
	for (const { name, field } of otherCollections) {
		const q: any = {};
		q[field] = { $in: ids };
		const n = await db.collection(name).countDocuments(q).catch(() => -1);
		if (n === -1) console.log(`  ${name}: (collection missing or query error)`);
		else console.log(`  ${name} (${field}): ${n} referencing docs`);
	}

	console.log('\nDone.');
	await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
