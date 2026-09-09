/**
 * Kanban status ↔ activityLog drift check + repair (2026-09-09).
 *
 * The flow history / CFD (src/lib/server/kanban/flow-history.ts) replays
 * activityLog `status_change` entries, so any task whose stored status
 * disagrees with its last logged transition renders as a ghost on the chart.
 * Root cause of the 2026-09 ghosts: the KB2 migrations wrote status with a raw
 * updateMany and no log entry. The model now rejects update-operator status
 * writes (kanban-task.ts guard); this script closes the historical gap.
 *
 * Reports:
 *   1. ROGUE — status not in the KB2 vocabulary (pre-KB2 'backlog' etc.)
 *   2. LAG   — status ≠ last status_change.to
 *   3. UNLOGGED — non-captured task with no status_change entry at all
 *
 * Dry-run by default. APPLY=1 repairs, idempotently:
 *   LAG / UNLOGGED → append ONE synthetic status_change {from: lastLogged, to: status,
 *                    synthetic: true} dated statusChangedAt ?? archivedAt ?? updatedAt.
 *   ROGUE          → status → 'icebox' (parked, visible behind the Icebox toggle — the
 *                    least disruptive legal home for a forgotten pre-KB2 backlog item)
 *                    + the same synthetic entry. Uses the guard's escape hatch.
 * Every repair writes an AuditLog row.
 *
 *   npx tsx scripts/diag-kanban-status-drift.ts
 *   APPLY=1 npx tsx scripts/diag-kanban-status-drift.ts
 */
import * as dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';
import { connectDB, KanbanTask, AuditLog, generateId } from '../src/lib/server/db';
import { isKanbanStatus } from '../src/lib/shared/kanban-status';

const APPLY = process.env.APPLY === '1';
const ROGUE_HOME = 'icebox';

async function main() {
	await connectDB();
	const rows = (await KanbanTask.find({})
		.select('_id trackingNumber title status archived archivedAt activityLog statusChangedAt updatedAt')
		.lean()) as any[];
	type Row = { t: any; last: string | null; kind: 'ROGUE' | 'LAG' | 'UNLOGGED' };
	const found: Row[] = [];
	for (const t of rows) {
		const log = (t.activityLog ?? [])
			.filter((e: any) => e.action === 'status_change' && e.details?.to)
			.sort((a: any, b: any) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
		const last = log.at(-1)?.details?.to ?? null;
		if (!isKanbanStatus(t.status)) found.push({ t, last, kind: 'ROGUE' });
		else if (last && last !== t.status) found.push({ t, last, kind: 'LAG' });
		else if (!last && t.status !== 'captured') found.push({ t, last, kind: 'UNLOGGED' });
	}
	console.log(`${rows.length} tasks scanned; ${found.length} drifted; mode = ${APPLY ? 'APPLY' : 'dry-run'}`);
	for (const kind of ['ROGUE', 'LAG', 'UNLOGGED'] as const) {
		const list = found.filter((x) => x.kind === kind);
		console.log(`\n${kind} (${list.length}):`);
		for (const x of list) {
			const target = kind === 'ROGUE' ? ROGUE_HOME : x.t.status;
			const at = new Date(x.t.statusChangedAt ?? x.t.archivedAt ?? x.t.updatedAt ?? Date.now());
			console.log(
				`  ${x.t.trackingNumber ?? '-'} ${String(x.t.title).slice(0, 50)}  status=${x.t.status}${x.t.archived ? ' (archived)' : ''}  lastLogged=${x.last ?? '—'}` +
					`  → ${APPLY ? 'repair' : 'would'}: log ${x.last ?? '?'}→${target} @ ${at.toISOString().slice(0, 10)}${kind === 'ROGUE' ? ` + status ${ROGUE_HOME}` : ''}`
			);
			if (!APPLY) continue;
			const entry = {
				_id: generateId(),
				action: 'status_change',
				details: { from: x.last ?? x.t.status, to: target, synthetic: true, reason: `drift repair (${kind}) — scripts/diag-kanban-status-drift.ts` },
				createdAt: at,
				createdBy: 'system'
			};
			const update: any = { $push: { activityLog: entry } };
			if (kind === 'ROGUE') update.$set = { status: target, statusChangedAt: at };
			await KanbanTask.updateOne({ _id: x.t._id }, update).setOptions({ allowRawStatusWrite: kind === 'ROGUE' });
			await AuditLog.create({
				_id: generateId(),
				tableName: 'kanban_tasks',
				recordId: String(x.t._id),
				action: 'UPDATE',
				newData: { driftRepair: kind, from: x.last, to: target, via: 'script:diag-kanban-status-drift' },
				changedBy: 'system',
				changedAt: new Date()
			});
		}
	}
	await mongoose.disconnect();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
