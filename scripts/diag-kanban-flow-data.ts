/**
 * Read-only diagnostic: how much kanban flow data actually exists?
 * Feeds the two-tier kanban refactor plan (SLE seeding, migration sizing).
 * Run: npx tsx scripts/diag-kanban-flow-data.ts
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const tasks = db.collection('kanban_tasks');
	const projects = db.collection('kanban_projects');

	console.log('=== Projects ===');
	console.log('total:', await projects.countDocuments());

	console.log('\n=== Tasks by archived x status ===');
	const byStatus = await tasks
		.aggregate([{ $group: { _id: { archived: '$archived', status: '$status' }, n: { $sum: 1 } } }, { $sort: { n: -1 } }])
		.toArray();
	for (const r of byStatus) console.log(`  archived=${r._id.archived ?? false} status=${r._id.status}: ${r.n}`);

	console.log('\n=== Flow-data coverage ===');
	const total = await tasks.countDocuments();
	console.log('total tasks:', total);
	console.log('with transitions[] non-empty:', await tasks.countDocuments({ 'transitions.0': { $exists: true } }));
	console.log('with wipDate:', await tasks.countDocuments({ wipDate: { $exists: true, $ne: null } }));
	console.log('with completedDate:', await tasks.countDocuments({ completedDate: { $exists: true, $ne: null } }));
	console.log('with readyDate:', await tasks.countDocuments({ readyDate: { $exists: true, $ne: null } }));
	console.log('with parentTaskId:', await tasks.countDocuments({ parentTaskId: { $exists: true, $ne: null } }));
	console.log('prioritized=true:', await tasks.countDocuments({ prioritized: true }));
	console.log('sortOrder set (>0):', await tasks.countDocuments({ sortOrder: { $gt: 0 } }));
	console.log("status='blocked' (not in model enum):", await tasks.countDocuments({ status: 'blocked' }));

	console.log('\n=== Cycle-time sample (archived done with wipDate+completedDate) ===');
	const done = await tasks
		.find(
			{ completedDate: { $ne: null }, wipDate: { $ne: null } },
			{ projection: { wipDate: 1, completedDate: 1, taskLength: 1, createdAt: 1 } }
		)
		.toArray();
	console.log('items with computable wip→done cycle time:', done.length);
	if (done.length) {
		const days = done
			.map((t) => (new Date(t.completedDate).getTime() - new Date(t.wipDate).getTime()) / 86400000)
			.filter((d) => d >= 0)
			.sort((a, b) => a - b);
		const pct = (p: number) => days[Math.min(days.length - 1, Math.floor((p / 100) * days.length))]?.toFixed(1);
		console.log(`  n=${days.length}  p50=${pct(50)}d  p85=${pct(85)}d  p95=${pct(95)}d  max=${days[days.length - 1]?.toFixed(1)}d`);
		const byLen: Record<string, number[]> = {};
		for (const t of done) {
			const d = (new Date(t.completedDate).getTime() - new Date(t.wipDate).getTime()) / 86400000;
			if (d < 0) continue;
			(byLen[t.taskLength ?? 'unset'] ??= []).push(d);
		}
		for (const [len, arr] of Object.entries(byLen)) {
			arr.sort((a, b) => a - b);
			const p85 = arr[Math.min(arr.length - 1, Math.floor(0.85 * arr.length))];
			console.log(`  ${len}: n=${arr.length} p85=${p85?.toFixed(1)}d`);
		}
	}

	console.log('\n=== Assignee spread (active, non-archived) ===');
	const byAssignee = await tasks
		.aggregate([
			{ $match: { archived: { $ne: true }, status: { $in: ['wip', 'ready', 'waiting'] } } },
			{ $group: { _id: { u: '$assignee.username', s: '$status' }, n: { $sum: 1 } } },
			{ $sort: { n: -1 } }
		])
		.toArray();
	for (const r of byAssignee) console.log(`  ${r._id.u ?? '(unassigned)'} ${r._id.s}: ${r.n}`);

	await mongoose.disconnect();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
