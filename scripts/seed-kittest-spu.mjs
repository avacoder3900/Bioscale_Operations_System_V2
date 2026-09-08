/**
 * Put a throwaway in-build SPU into the bioscale_kittest mirror so the
 * "Withdraw SPU Kit" picker has something to select.
 *
 * The button only offers units in IN_BUILD_STATUSES (draft | assembling), and
 * the prod snapshot happens to contain none, so the mirror needs one seeded.
 *
 * WRITES ONLY to bioscale_kittest. Never touches bioscale.
 *
 * Usage:
 *   node scripts/seed-kittest-spu.mjs           # report status distribution
 *   node scripts/seed-kittest-spu.mjs --apply   # seed the throwaway unit
 */

import { MongoClient } from 'mongodb';
import { readFileSync } from 'node:fs';

const TARGET_DB = 'bioscale_kittest';
const APPLY = process.argv.includes('--apply');

function readUri() {
	const raw = readFileSync('C:/Users/aleja/.env', 'utf8');
	for (const line of raw.split(/\r?\n/)) {
		const m = line.match(/^\s*MONGODB_URI\s*=\s*(.*)$/);
		if (m) return m[1].trim().replace(/^["']|["']$/g, '');
	}
	throw new Error('MONGODB_URI not found in C:/Users/aleja/.env');
}

async function main() {
	if (TARGET_DB !== 'bioscale_kittest') {
		throw new Error('REFUSING: this script only ever writes to bioscale_kittest.');
	}

	const client = new MongoClient(readUri(), { serverSelectionTimeoutMS: 15000 });
	await client.connect();
	const dst = client.db(TARGET_DB);

	const dist = await dst
		.collection('spus')
		.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }, { $sort: { n: -1 } }])
		.toArray();

	console.log(`status distribution in ${TARGET_DB}.spus:`);
	console.table(dist.map((d) => ({ status: d._id, count: d.n })));

	// Reuse the shape of a real unit so every downstream field the page reads
	// is present, then override identity + status. Copying beats hand-rolling a
	// document: the schema has grown fields this script should not have to know.
	const template = await dst.collection('spus').findOne({}, { sort: { createdAt: -1 } });
	if (!template) throw new Error('mirror has no spus to use as a template');

	const seeded = {
		...template,
		_id: 'kittest-spu-001',
		udi: 'KITTEST-001',
		barcode: 'KITTEST-001',
		serialNumber: 'KITTEST-001',
		status: 'assembling',
		assignedCustomer: null,
		notes: 'Throwaway unit seeded for SPU kit withdrawal testing. Mirror database only.',
		createdAt: new Date(),
		updatedAt: new Date()
	};

	console.log(`\ntemplate unit: ${template.udi ?? template._id} (status ${template.status})`);
	console.log(`seeding:       ${seeded.udi} [assembling]  _id=${seeded._id}`);

	if (APPLY) {
		await dst.collection('spus').deleteOne({ _id: seeded._id });
		await dst.collection('spus').insertOne(seeded);

		const check = await dst
			.collection('spus')
			.countDocuments({ status: { $in: ['draft', 'assembling'] } });
		console.log(`\nin-build SPUs in mirror now: ${check}`);
	} else {
		console.log('\nDry run only. Re-run with --apply to seed.');
	}

	await client.close();
}

main().catch((err) => {
	console.error('FAILED:', err.message);
	process.exit(1);
});
