/**
 * Read-only diagnostic: distribution of SPU statuses in Atlas, plus related
 * fields that matter for the status-flow collapse (SPU-INV-07 planning).
 * Run: npx tsx scripts/diag-spu-statuses.ts
 */
import 'dotenv/config';
import mongoose from 'mongoose';

async function main() {
	const uri = process.env.MONGODB_URI;
	if (!uri) throw new Error('MONGODB_URI not set');
	await mongoose.connect(uri);
	const db = mongoose.connection.db!;
	const spus = db.collection('spus');

	const byStatus = await spus
		.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }, { $sort: { n: -1 } }])
		.toArray();
	console.log('--- spus.status distribution ---');
	for (const r of byStatus) console.log(`${String(r._id).padEnd(24)} ${r.n}`);

	const total = await spus.countDocuments();
	console.log(`TOTAL ${total}`);

	console.log('\n--- transitions referencing to-be-removed statuses (statusTransitions.to) ---');
	const removed = ['assembled', 'validated', 'deployed', 'voided', 'released-rnd', 'released-manufacturing', 'released-field', 'assigned'];
	const trans = await spus
		.aggregate([
			{ $unwind: '$statusTransitions' },
			{ $match: { 'statusTransitions.to': { $in: removed } } },
			{ $group: { _id: '$statusTransitions.to', n: { $sum: 1 } } },
			{ $sort: { n: -1 } }
		])
		.toArray();
	for (const r of trans) console.log(`${String(r._id).padEnd(24)} ${r.n}`);

	console.log('\n--- ServiceRecord previousStatus / returnedToStatus values ---');
	const sr = db.collection('service_records');
	for (const field of ['previousStatus', 'returnedToStatus', 'status']) {
		const vals = await sr
			.aggregate([{ $group: { _id: `$${field}`, n: { $sum: 1 } } }, { $sort: { n: -1 } }])
			.toArray();
		console.log(`${field}:`, vals.map((v) => `${v._id}=${v.n}`).join('  '));
	}

	console.log('\n--- deviceState values (candidate location vocabulary) ---');
	const ds = await spus
		.aggregate([{ $group: { _id: '$deviceState', n: { $sum: 1 } } }, { $sort: { n: -1 } }])
		.toArray();
	for (const r of ds) console.log(`${String(r._id).padEnd(24)} ${r.n}`);

	console.log('\n--- owner values ---');
	const own = await spus
		.aggregate([{ $group: { _id: '$owner', n: { $sum: 1 } } }, { $sort: { n: -1 } }])
		.toArray();
	for (const r of own) console.log(`${String(r._id).padEnd(24)} ${r.n}`);

	await mongoose.disconnect();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
