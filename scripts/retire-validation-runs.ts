/**
 * Retire the validation-runs concept (Jacob, 2026-09-08).
 *
 * Nothing is deleted: each run's membership + per-step cell state is appended
 * to every member SPU's unified journal (source 'validation'), then the run
 * is marked aborted with a retirement reason. The /validation/runs route
 * stays reachable by URL; navigation entry points are removed in code.
 *
 *   npx tsx scripts/retire-validation-runs.ts          # dry run
 *   npx tsx scripts/retire-validation-runs.ts --apply
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { customAlphabet } from 'nanoid';

const generateId = customAlphabet('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', 21);
const ACTOR = { _id: 'system:runs-retirement', username: 'runs-retirement-2026-09-08' };
const REASON = 'Validation-runs concept retired 2026-09-08 — membership journaled onto each unit; results live in validation sessions and SPU rollups.';

async function main() {
	const apply = process.argv.includes('--apply');
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const runsCol = db.collection('validation_runs');
	const spus = db.collection('spus');
	const audit = db.collection('audit_logs');

	console.log(apply ? '=== APPLY ===' : '=== DRY RUN (pass --apply to write) ===');
	const runs = await runsCol.find({}).toArray();
	for (const run of runs as any[]) {
		console.log(`\n${run.runNumber} (${run.status}) "${run.name ?? ''}" — ${(run.spus ?? []).length} members`);
		for (const m of run.spus ?? []) {
			const spu = await spus.findOne({ _id: m.spuId }, { projection: { udi: 1, journal: 1 } });
			if (!spu) {
				console.log(`  ${m.udi ?? m.spuId}: SPU no longer exists — skipped`);
				continue;
			}
			const steps = m.steps ?? {};
			const stepLine = Object.entries(steps)
				.map(([k, v]: [string, any]) => `${k}: ${v?.status ?? 'not_started'}`)
				.join(', ');
			const text =
				`Validation run ${run.runNumber}${run.name ? ` ("${run.name}")` : ''} — recorded at concept retirement.\n` +
				`Member since ${m.addedAt ? new Date(m.addedAt).toISOString().slice(0, 10) : '?'}` +
				`${m.removedAt ? ` (removed ${new Date(m.removedAt).toISOString().slice(0, 10)})` : ''}.\n` +
				`Step state: ${stepLine || 'no steps recorded'}.\n` +
				`Runs were retired as a concept on 2026-09-08; test evidence lives in validation sessions and this unit's validation rollups.`;

			const already = ((spu as any).journal ?? []).some(
				(j: any) => j.refKind === 'validation_run' && j.refId === run._id
			);
			if (already) {
				console.log(`  ${(spu as any).udi}: journal entry already present — skipped`);
				continue;
			}
			console.log(`  ${(spu as any).udi}: + journal (${stepLine || 'no steps'})`);
			if (apply) {
				const entry = {
					_id: generateId(),
					text,
					source: 'validation',
					refKind: 'validation_run',
					refId: run._id,
					refLabel: `${run.runNumber}${run.name ? ` — ${run.name}` : ''}`,
					createdBy: ACTOR,
					createdAt: new Date()
				};
				await spus.updateOne({ _id: m.spuId }, { $push: { journal: entry } as any });
				await audit.insertOne({
					_id: generateId(),
					tableName: 'spus',
					recordId: m.spuId,
					action: 'UPDATE',
					oldData: {},
					newData: { journalEntryAdded: entry._id, source: 'validation', runNumber: run.runNumber },
					reason: REASON,
					changedBy: ACTOR.username,
					changedAt: new Date()
				});
			}
		}
		if (run.status === 'in_progress') {
			console.log(`  → mark ${run.runNumber} aborted (retirement)`);
			if (apply) {
				await runsCol.updateOne(
					{ _id: run._id },
					{ $set: { status: 'aborted', abortReason: REASON, completedAt: new Date() } }
				);
				await audit.insertOne({
					_id: generateId(),
					tableName: 'validation_runs',
					recordId: run._id,
					action: 'UPDATE',
					oldData: { status: 'in_progress' },
					newData: { status: 'aborted' },
					reason: REASON,
					changedBy: ACTOR.username,
					changedAt: new Date()
				});
			}
		}
	}
	await mongoose.disconnect();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
