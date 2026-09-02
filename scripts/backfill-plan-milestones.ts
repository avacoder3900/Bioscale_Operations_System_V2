/**
 * KB2-39 backfill — link existing PlanningDocuments to the milestone they
 * workshopped. Parses "**Milestone:** TASK-NNN" (first occurrence) from each
 * plan's content, resolves the tracking number to a task id, and sets
 * plan.milestoneId. Plans that name zero or several milestones (e.g. the
 * Fall roadmap v4) are left alone and reported.
 *
 * Dry-run by default. APPLY=1 writes. Idempotent — plans that already carry
 * a milestoneId are skipped.
 *
 *   npx tsx scripts/backfill-plan-milestones.ts
 *   APPLY=1 npx tsx scripts/backfill-plan-milestones.ts
 */
import * as dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';
import { connectDB, KanbanTask, PlanningDocument, AuditLog, generateId } from '../src/lib/server/db';

const APPLY = process.env.APPLY === '1';

async function main() {
	await connectDB();
	const plans = (await PlanningDocument.find({}).select('_id title version content milestoneId').lean()) as any[];
	console.log(`${plans.length} plan(s); mode = ${APPLY ? 'APPLY' : 'dry-run'}`);

	for (const p of plans) {
		const label = `${p.title} ${p.version ?? ''}`.trim();
		if (p.milestoneId) {
			console.log(`  skip   ${label} — already linked to ${p.milestoneId}`);
			continue;
		}
		// Only the explicit "Milestone: TASK-NNN" header line counts; the body
		// of a roadmap mentions milestones it does not own.
		const matches = [...String(p.content).matchAll(/\*\*Milestone:\*\*\s*(TASK-\d+)/gi)].map((m) => m[1].toUpperCase());
		const unique = [...new Set(matches)];
		if (unique.length !== 1) {
			console.log(`  leave  ${label} — ${unique.length ? `names ${unique.length} milestones (${unique.join(', ')})` : 'no "**Milestone:** TASK-NNN" header'}`);
			continue;
		}
		const task = (await KanbanTask.findOne({ trackingNumber: unique[0] }).select('_id title itemType').lean()) as any;
		if (!task) {
			console.log(`  leave  ${label} — ${unique[0]} not found`);
			continue;
		}
		if (task.itemType !== 'milestone') {
			console.log(`  leave  ${label} — ${unique[0]} is itemType '${task.itemType}', not a milestone`);
			continue;
		}
		console.log(`  ${APPLY ? 'link ' : 'would'}  ${label} → ${unique[0]} "${task.title}" (${task._id})`);
		if (APPLY) {
			await PlanningDocument.updateOne({ _id: p._id }, { $set: { milestoneId: String(task._id) } });
			await AuditLog.create({
				_id: generateId(),
				tableName: 'planning_documents',
				recordId: p._id,
				action: 'UPDATE',
				newData: { milestoneId: String(task._id), via: 'script:backfill-plan-milestones' },
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
