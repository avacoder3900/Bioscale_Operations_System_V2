/**
 * Diagnose why the cart-mfg-dev dashboard "Backing" tile shows the wrong count.
 *
 * Hypothesis: load function groups by `$currentPhase`, but the canonical field
 * is `status`. Some legacy records still carry `currentPhase`. Compare both.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const coll = db.collection('cartridge_records');

	const total = await coll.countDocuments({});
	console.log(`Total cartridge_records: ${total}`);

	console.log('\n=== Group by $currentPhase (what dashboard uses) ===');
	const byCurrentPhase = await coll.aggregate([
		{ $group: { _id: '$currentPhase', count: { $sum: 1 } } },
		{ $sort: { count: -1 } }
	]).toArray();
	for (const g of byCurrentPhase) console.log(`  ${JSON.stringify(g._id)}: ${g.count}`);

	console.log('\n=== Group by $status (what model actually defines) ===');
	const byStatus = await coll.aggregate([
		{ $group: { _id: '$status', count: { $sum: 1 } } },
		{ $sort: { count: -1 } }
	]).toArray();
	for (const g of byStatus) console.log(`  ${JSON.stringify(g._id)}: ${g.count}`);

	console.log('\n=== Records with BOTH currentPhase and status ===');
	const both = await coll.aggregate([
		{ $match: { currentPhase: { $exists: true }, status: { $exists: true } } },
		{ $group: { _id: { currentPhase: '$currentPhase', status: '$status' }, count: { $sum: 1 } } },
		{ $sort: { count: -1 } }
	]).toArray();
	for (const g of both) console.log(`  currentPhase=${g._id.currentPhase}  status=${g._id.status}  count=${g.count}`);

	console.log('\n=== currentPhase only (legacy, no status) ===');
	const legacyOnly = await coll.countDocuments({ currentPhase: { $exists: true }, status: { $exists: false } });
	console.log(`  ${legacyOnly}`);

	console.log('\n=== status only (modern, no currentPhase) ===');
	const modernOnly = await coll.countDocuments({ status: { $exists: true }, currentPhase: { $exists: false } });
	console.log(`  ${modernOnly}`);

	console.log('\n=== Neither field present ===');
	const neither = await coll.countDocuments({ status: { $exists: false }, currentPhase: { $exists: false } });
	console.log(`  ${neither}`);

	await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
