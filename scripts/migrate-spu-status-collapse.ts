/**
 * SPU-INV-07 data migration: collapse the SPU status vocabulary.
 *
 *   assembled → validating       validated → validating
 *   released-rnd → released (+ location 'R&D')
 *   released-manufacturing / released-field / deployed → released
 *   voided → retired             assigned (rogue) → draft
 *
 * Also remaps service_records.previousStatus / returnedToStatus the same way
 * (the close ladder writes previousStatus back into spu.status).
 * statusTransitions history is deliberately left untouched — immutable log.
 *
 * Idempotent and re-runnable. Run AFTER the code deploy:
 *   npx tsx scripts/migrate-spu-status-collapse.ts          # dry run
 *   npx tsx scripts/migrate-spu-status-collapse.ts --apply  # write
 */
import 'dotenv/config';
import mongoose from 'mongoose';

const MAP: Record<string, string> = {
	assembled: 'validating',
	validated: 'validating',
	'released-rnd': 'released',
	'released-manufacturing': 'released',
	'released-field': 'released',
	deployed: 'released',
	voided: 'retired',
	assigned: 'draft'
};

async function main() {
	const apply = process.argv.includes('--apply');
	const uri = process.env.MONGODB_URI;
	if (!uri) throw new Error('MONGODB_URI not set');
	await mongoose.connect(uri);
	const db = mongoose.connection.db!;
	const spus = db.collection('spus');
	const serviceRecords = db.collection('service_records');

	console.log(apply ? '=== APPLY MODE ===' : '=== DRY RUN (pass --apply to write) ===');

	console.log('\n--- spus.status before ---');
	for (const r of await spus.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }, { $sort: { n: -1 } }]).toArray()) {
		console.log(`${String(r._id).padEnd(24)} ${r.n}`);
	}

	for (const [oldStatus, newStatus] of Object.entries(MAP)) {
		const filter = { status: oldStatus };
		const n = await spus.countDocuments(filter);
		if (n === 0) continue;
		// released-rnd carried a location, not just a lifecycle state.
		const set: Record<string, string> =
			oldStatus === 'released-rnd' ? { status: newStatus, location: 'R&D' } : { status: newStatus };
		console.log(`spus: ${oldStatus} → ${JSON.stringify(set)} (${n} docs)`);
		if (apply) await spus.updateMany(filter, { $set: set });
	}

	for (const field of ['previousStatus', 'returnedToStatus']) {
		for (const [oldStatus, newStatus] of Object.entries(MAP)) {
			const filter = { [field]: oldStatus };
			const n = await serviceRecords.countDocuments(filter);
			if (n === 0) continue;
			console.log(`service_records.${field}: ${oldStatus} → ${newStatus} (${n} docs)`);
			if (apply) await serviceRecords.updateMany(filter, { $set: { [field]: newStatus } });
		}
	}

	console.log('\n--- spus.status after ---');
	for (const r of await spus.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }, { $sort: { n: -1 } }]).toArray()) {
		console.log(`${String(r._id).padEnd(24)} ${r.n}`);
	}
	console.log('\n--- service_records.previousStatus after ---');
	for (const r of await serviceRecords.aggregate([{ $group: { _id: '$previousStatus', n: { $sum: 1 } } }, { $sort: { n: -1 } }]).toArray()) {
		console.log(`${String(r._id).padEnd(24)} ${r.n}`);
	}

	await mongoose.disconnect();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
