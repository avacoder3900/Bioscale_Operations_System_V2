/**
 * migrate-execution-notes-to-observations.ts
 *
 * One-shot migration for research-v2 ProtocolExecution docs. The pre-
 * unification schema had a single `stepRecords[].notes: String` per step.
 * Unified schema adds `stepRecords[].observations[]` (multi-note, each with
 * author + timestamp + concern flag).
 *
 * This migrator finds every protocol_executions doc with at least one
 * stepRecords entry that has a non-empty `notes` AND an empty (or absent)
 * `observations` array, and pushes a single observation built from that
 * notes string. The original `notes` field is preserved for one release as
 * back-compat (don't delete it here — that's a follow-up after the research-
 * v2 UI is updated to read from observations[]).
 *
 * Idempotent: docs that already have observations populated are skipped.
 *
 * Usage:
 *   npx tsx scripts/migrate-execution-notes-to-observations.ts --dry-run
 *   npx tsx scripts/migrate-execution-notes-to-observations.ts --execute
 */

import mongoose from 'mongoose';
import { nanoid } from 'nanoid';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
	const args = new Set(process.argv.slice(2));
	const dryRun = args.has('--dry-run');
	const execute = args.has('--execute');

	if (!dryRun && !execute) {
		console.error('Pass either --dry-run or --execute.');
		process.exit(1);
	}
	if (dryRun && execute) {
		console.error('Pass only one of --dry-run / --execute, not both.');
		process.exit(1);
	}

	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;

	const cursor = db
		.collection('protocol_executions')
		.find({}, { projection: { _id: 1, definitionName: 1, executedBy: 1, stepRecords: 1 } });

	const docs = await cursor.toArray();
	console.log(`Found ${docs.length} protocol_executions doc(s).`);
	console.log('');

	let touched = 0;
	let observationsAdded = 0;
	let skipped = 0;

	const now = new Date();

	for (const doc of docs as any[]) {
		const steps = doc.stepRecords ?? [];
		const updatedSteps: any[] = [];
		let anyChange = false;

		for (const s of steps) {
			const existingObs = Array.isArray(s.observations) ? s.observations : [];
			const noteStr = (s.notes ?? '').trim();
			if (noteStr.length > 0 && existingObs.length === 0) {
				const obs = {
					_id: nanoid(),
					promptKey: '',
					body: noteStr,
					concern: false,
					enteredBy: s.completedBy ?? doc.executedBy ?? '',
					enteredAt: s.completedAt ? new Date(s.completedAt) : now,
					updatedAt: now
				};
				updatedSteps.push({ ...s, observations: [obs] });
				observationsAdded++;
				anyChange = true;
			} else {
				updatedSteps.push(s);
			}
		}

		if (!anyChange) {
			skipped++;
			continue;
		}

		console.log(`  Doc ${doc._id} (${doc.definitionName ?? 'unnamed'}): adding observations to ${anyChange ? 'some steps' : 'no steps'}`);
		touched++;

		if (execute) {
			await db
				.collection('protocol_executions')
				.updateOne({ _id: doc._id }, { $set: { stepRecords: updatedSteps } });
		}
	}

	console.log('');
	console.log(
		`Summary: touched=${touched}  skipped=${skipped}  observationsAdded=${observationsAdded}`
	);
	if (dryRun) {
		console.log('');
		console.log('Dry-run. Re-run with --execute to apply.');
	} else if (execute) {
		console.log('Applied.');
	}

	await mongoose.disconnect();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
