/**
 * CFD ghost-task backfill (2026-09-09, Jacob: "the board is the truth").
 *
 * The flow-history CFD reconstructs each task's status-per-day from
 * activityLog status_change entries. 27 tasks were moved (mostly demoted to
 * captured during migration-era sweeps) WITHOUT a log entry, so the CFD
 * freezes them at their last logged board status — ghost Waiting/Ready/WIP
 * columns that don't exist on the board.
 *
 * Fix: append one synthetic status_change entry per ghost, to its CURRENT
 * status, dated statusChangedAt ?? updatedAt ?? now — so history converges
 * where the data says the move actually happened. Idempotent.
 *
 *   npx tsx scripts/backfill-kanban-cfd-ghosts.ts          # dry run
 *   npx tsx scripts/backfill-kanban-cfd-ghosts.ts --apply
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { customAlphabet } from 'nanoid';

const generateId = customAlphabet('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', 21);

async function main() {
	const apply = process.argv.includes('--apply');
	await mongoose.connect(process.env.MONGODB_URI!);
	const col = mongoose.connection.db!.collection('kanban_tasks');
	console.log(apply ? '=== APPLY ===' : '=== DRY RUN (pass --apply to write) ===');

	const tasks = await col
		.find({})
		.project({ title: 1, status: 1, archived: 1, archivedAt: 1, activityLog: 1, statusChangedAt: 1, updatedAt: 1 })
		.toArray();

	let fixed = 0;
	for (const t of tasks as any[]) {
		if (t.archived && t.archivedAt) continue;
		const log = (t.activityLog ?? []).filter((e: any) => e.action === 'status_change' && e.details?.to);
		const last = log.length
			? log.sort((a: any, b: any) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()).at(-1).details.to
			: 'captured';
		if (last === t.status) continue;

		const at = t.statusChangedAt ?? t.updatedAt ?? new Date();
		console.log(`  ${String(t.title).slice(0, 50).padEnd(52)} log says '${last}' → actual '${t.status}' (dated ${new Date(at).toISOString().slice(0, 10)})`);
		fixed++;
		if (apply) {
			await col.updateOne(
				{ _id: t._id },
				{
					$push: {
						activityLog: {
							_id: generateId(),
							action: 'status_change',
							details: { from: last, to: t.status, note: 'backfill: log entry was missing for this move (CFD ghost fix 2026-09-09)' },
							createdBy: 'system:cfd-backfill',
							createdAt: new Date(at)
						}
					} as any
				}
			);
		}
	}
	console.log(`\n${fixed} ghost tasks ${apply ? 'backfilled' : 'to backfill'}`);
	await mongoose.disconnect();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
