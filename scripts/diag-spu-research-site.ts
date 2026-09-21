/** Read-only: SPU assignment state for the research-site reassignment request. */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

const WANTED = ['243','245','248','247','250','211','222','212','229','218','249','223','236','251','244','202'];

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const spus = db.collection('spus');

	console.log('=== Distinct assignment.customer values across all SPUs ===');
	const customers = await spus
		.aggregate([{ $group: { _id: { id: '$assignment.customer._id', name: '$assignment.customer.name', type: '$assignment.type' }, n: { $sum: 1 } } }, { $sort: { n: -1 } }])
		.toArray();
	for (const c of customers) console.log(`  type=${c._id.type} customer=${c._id.name} (${c._id.id}): ${c.n}`);

	console.log('\n=== Customers collection entries that look like R&D/research ===');
	const rnd = await db.collection('customers').find({ name: { $regex: 'r&d|research|rnd|internal', $options: 'i' } }).project({ name: 1 }).toArray();
	for (const c of rnd) console.log(`  ${c._id}: ${c.name}`);

	console.log('\n=== UDI format sample ===');
	const sample = await spus.find({}).project({ udi: 1, status: 1 }).limit(5).toArray();
	for (const s of sample) console.log(`  ${s._id} udi=${s.udi} status=${s.status}`);

	console.log('\n=== The 16 requested SPUs (matched by UDI containing the number) ===');
	for (const n of WANTED) {
		const doc = await spus.findOne(
			{ udi: { $regex: `${n}$` } },
			{ projection: { udi: 1, status: 1, assignment: 1 } }
		);
		if (!doc) { console.log(`  ${n}: NOT FOUND`); continue; }
		console.log(`  ${n}: udi=${doc.udi} status=${doc.status} assignment.type=${doc.assignment?.type} customer=${doc.assignment?.customer?.name ?? 'null'}`);
	}

	await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
