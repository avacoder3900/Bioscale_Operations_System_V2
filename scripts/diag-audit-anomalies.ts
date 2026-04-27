import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;

	console.log('=== WAXQC BACKFILL OPERATOR SEARCH ===');
	// Try multiple possible field/value combinations
	const variants: Array<[string, any]> = [
		['waxQc.operator: system-backfill', { 'waxQc.operator': 'system-backfill' }],
		['waxQc.operatorUsername: system-backfill', { 'waxQc.operatorUsername': 'system-backfill' }],
		['waxQc.operator.username: system-backfill', { 'waxQc.operator.username': 'system-backfill' }],
		['any waxQc Accepted with no operator', { 'waxQc.status': 'Accepted', 'waxQc.operator': { $exists: false } }],
		['any waxQc Accepted', { 'waxQc.status': 'Accepted' }],
	];
	for (const [label, query] of variants) {
		const n = await db.collection('cartridge_records').countDocuments(query);
		console.log(`  ${label}: ${n}`);
	}
	// sample one Accepted cart to see the actual shape
	const sample = await db.collection('cartridge_records').findOne({ 'waxQc.status': 'Accepted' });
	if (sample) console.log('  sample waxQc shape:', JSON.stringify((sample as any).waxQc));

	console.log('\n=== BACKFILL AUDIT ENTRY ===');
	const backfillAudit = await db.collection('audit_logs').findOne({ _id: 'aiUsESm2QKWzO7JIuSaiN' } as any);
	if (backfillAudit) {
		const a: any = backfillAudit;
		console.log(`  _id: ${a._id}`);
		console.log(`  action: ${a.action}`);
		console.log(`  tableName: ${a.tableName}`);
		console.log(`  changedBy: ${a.changedBy}`);
		console.log(`  changedAt: ${a.changedAt}`);
		console.log(`  newData keys: ${a.newData ? Object.keys(a.newData).join(',') : 'none'}`);
		if (a.newData?.recordCount) console.log(`  newData.recordCount: ${a.newData.recordCount}`);
		if (a.newData?.rationale) console.log(`  newData.rationale: ${a.newData.rationale}`);
		if (a.notes) console.log(`  notes: ${a.notes}`);
	}

	console.log('\n=== NANOID-ID CARTS IN ACTIVE STATE (Doc 3 §2.2) ===');
	const nanoids = await db.collection('cartridge_records').find({
		_id: { $not: /^[0-9a-f-]{36}$/i } as any,
		status: { $nin: ['voided', 'scrapped', 'completed', 'cancelled', 'shipped'] }
	}).project({ _id: 1, status: 1, createdAt: 1, 'backing.lotId': 1 }).toArray();
	console.log(`  count: ${nanoids.length}`);
	const statusHist: Record<string, number> = {};
	for (const c of nanoids as any[]) statusHist[c.status] = (statusHist[c.status] || 0) + 1;
	console.log(`  by status:`);
	for (const [s, n] of Object.entries(statusHist)) console.log(`    ${s}: ${n}`);
	const sampleIds = (nanoids as any[]).slice(0, 10).map(c => `    ${c._id}  status=${c.status}  createdAt=${c.createdAt}`);
	console.log('  samples:');
	console.log(sampleIds.join('\n'));
	const cartPrefixCount = (nanoids as any[]).filter(c => /^CART-/i.test(c._id)).length;
	console.log(`  of those, _id starts with "CART-": ${cartPrefixCount}`);

	console.log('\n=== ADVANCED-STATUS CARTS MISSING WAXQC.STATUS ===');
	const advStatuses = ['wax_filled', 'wax_stored', 'reagent_filling', 'reagent_filled', 'inspected', 'sealed', 'cured', 'stored', 'released', 'shipped', 'linked', 'underway', 'completed'];
	const gaps = await db.collection('cartridge_records').find({
		status: { $in: advStatuses },
		$or: [{ 'waxQc.status': { $exists: false } }, { 'waxQc.status': { $nin: ['Accepted', 'Rejected'] } }]
	}).project({ _id: 1, status: 1, createdAt: 1, 'waxQc': 1 }).toArray();
	console.log(`  count: ${gaps.length}`);
	for (const c of gaps.slice(0, 20) as any[]) {
		console.log(`    ${c._id}  status=${c.status}  createdAt=${c.createdAt?.toISOString?.() ?? c.createdAt}  waxQc=${JSON.stringify(c.waxQc) ?? '<undef>'}`);
	}

	await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
