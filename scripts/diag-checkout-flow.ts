import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;

	console.log('=== MANUAL CARTRIDGE REMOVAL (CHECKOUT) COLLECTION ===');
	const total = await db.collection('manual_cartridge_removals').countDocuments({});
	console.log(`total docs: ${total}`);
	const grouped = await db.collection('manual_cartridge_removals').aggregate([
		{ $group: { _id: '$reason', n: { $sum: 1 }, totalCarts: { $sum: { $size: { $ifNull: ['$cartridgeIds', []] } } } } },
		{ $sort: { n: -1 } }
	]).toArray();
	for (const g of grouped as any[]) {
		console.log(`  reason="${g._id?.slice?.(0, 80) ?? g._id}": ${g.n} doc(s), ${g.totalCarts} cart(s)`);
	}

	console.log('\n=== AUDIT LOG WITH ACTION=CHECKOUT ===');
	const checkoutAudits = await db.collection('audit_logs').countDocuments({ action: 'CHECKOUT' });
	console.log(`audit rows with action='CHECKOUT': ${checkoutAudits}`);

	console.log('\n=== WAX QC REJECT RECONCILIATION (memory note) ===');
	// Candidate runs: g1Hg16k8b (not rolled back), 2y2fFrx6 (done)
	const wantedRunPartials = ['g1Hg16k8b', '2y2fFrx6'];
	for (const partial of wantedRunPartials) {
		const wax = await db.collection('wax_filling_runs').find({ _id: { $regex: partial } as any }).project({ _id: 1, status: 1, robot: 1, operator: 1, runEndTime: 1 }).toArray();
		console.log(`  wax_filling_runs matching "${partial}": ${wax.length}`);
		for (const r of wax as any[]) console.log(`    _id=${r._id}  status=${r.status}  operator=${r.operator?.username}  end=${r.runEndTime}`);
	}

	console.log('\n=== WAX-STORED PHYSICAL GAP INCIDENT (FRIDGE-002, 20 ghost carts) ===');
	const totalWaxStored = await db.collection('cartridge_records').countDocuments({ status: 'wax_stored' });
	const checkedOut = await db.collection('cartridge_records').countDocuments({ status: 'wax_stored', 'storage.checkedOut': true });
	console.log(`wax_stored total now: ${totalWaxStored}  (was 78 yesterday, 59 physical)`);
	console.log(`wax_stored AND checkedOut=true: ${checkedOut}`);

	// Check the two groups mentioned in the incident commit
	const zaneGroup = await db.collection('manual_cartridge_removals').find({ reason: /Zane Testing/ }).project({ _id: 1, cartridgeIds: 1, reason: 1, removedAt: 1 }).toArray();
	console.log(`  "Zane Testing" removals: ${zaneGroup.length}`);
	const twoDays = await db.collection('manual_cartridge_removals').find({ reason: /After 2 Days/ }).project({ _id: 1, cartridgeIds: 1, reason: 1, removedAt: 1 }).toArray();
	console.log(`  "After 2 Days" removals: ${twoDays.length}`);

	// Count carts per group
	const zaneCarts = zaneGroup.reduce((s: number, g: any) => s + (g.cartridgeIds?.length ?? 0), 0);
	const twoCarts = twoDays.reduce((s: number, g: any) => s + (g.cartridgeIds?.length ?? 0), 0);
	console.log(`  Zane total cartridges: ${zaneCarts} (expect 8)`);
	console.log(`  "After 2 Days" total cartridges: ${twoCarts} (expect 12)`);

	console.log('\n=== ORPHAN 14 CARTRIDGES (pre-audit concern, user said resolved) ===');
	const orphanIds = [
		'56e22b9c-d5bd-4d7c-82cd-c002bb86f29b',
		'9d4d520b-6454-43cc-a8e6-681a4164560e',
		'af4cd787-aed5-4371-af41-85f93c6f97fb',
		'c95613a5-f267-4336-99df-39a6ac115216',
		'9a5aefe9-b4af-49e6-907b-f8fbb5dce2ab',
		'a87c7aa0-413d-4d40-91e1-06dad9b64295',
		'f7be9f9c-3371-4d65-b96d-a705d79ef05a',
		'decd0e58-5e06-43ae-a00e-831af583d612',
		'af717a43-b373-415a-8319-6c8c8c77265a',
		'f9a8d8b0-8d9e-4be0-aa51-8b9039c7800c',
		'095e1ce1-421b-4a6a-a7b6-28f3bf06043d',
		'8e8c7347-0feb-4654-ab18-921a898221e2',
		'78a723df-98c6-4d71-bbeb-c79d6b15c421',
		'6c7f15cb-3bd1-4314-a41b-aa05fd64f3d2'
	];
	const stillOrphan = await db.collection('cartridge_records').find({
		_id: { $in: orphanIds },
		$or: [{ 'waxQc.status': { $exists: false } }, { 'waxQc.status': { $nin: ['Accepted', 'Rejected'] } }],
		status: 'completed'
	}).project({ _id: 1, status: 1, 'waxQc.status': 1, voidReason: 1 }).toArray();
	console.log(`still orphaned (completed, no waxQc): ${stillOrphan.length}`);

	await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
