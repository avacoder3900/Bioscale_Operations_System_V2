/**
 * Read-only diagnostic: figure out why Alejandro doesn't show up in the WIP
 * timeline. Checks his user doc + samples his recent kanban_tasks to compare
 * assignee._id against his actual _id.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

const URI = process.env.MONGODB_URI!;

async function main() {
	await mongoose.connect(URI);
	const db = mongoose.connection.db!;

	const candidates = await db
		.collection('users')
		.find({ username: { $regex: /alejandr/i } })
		.project({ _id: 1, username: 1, firstName: 1, lastName: 1, wipLimit: 1, isActive: 1 })
		.toArray();

	console.log(`\n=== User candidates matching /alejandr/i (${candidates.length}) ===`);
	for (const u of candidates as any[]) {
		console.log(`  _id=${u._id}  username=${u.username}  name=${u.firstName} ${u.lastName}  wipLimit=${u.wipLimit}  isActive=${u.isActive}`);
	}

	if (candidates.length === 0) {
		console.log('No user matches "alejandr". Trying firstName/lastName...');
		const byName = await db
			.collection('users')
			.find({ $or: [{ firstName: /alejandr/i }, { lastName: /alejandr/i }] })
			.project({ _id: 1, username: 1, firstName: 1, lastName: 1, wipLimit: 1 })
			.toArray();
		console.log(`  byName.length = ${byName.length}`);
		for (const u of byName as any[]) {
			console.log(`  _id=${u._id}  username=${u.username}  name=${u.firstName} ${u.lastName}  wipLimit=${u.wipLimit}`);
		}
	}

	for (const u of candidates as any[]) {
		console.log(`\n=== Tasks assigned to ${u.username} (${u._id}) ===`);
		const tasks = await db
			.collection('kanban_tasks')
			.find({ 'assignee._id': u._id })
			.project({ _id: 1, title: 1, status: 1, assignee: 1, archived: 1, statusChangedAt: 1, activityLog: 1 })
			.toArray();
		console.log(`  total tasks: ${tasks.length}`);
		const byStatus: Record<string, number> = {};
		for (const t of tasks as any[]) {
			const key = `${t.status}${t.archived ? ' (archived)' : ''}`;
			byStatus[key] = (byStatus[key] ?? 0) + 1;
		}
		console.log(`  by status:`, byStatus);

		const wipTasks = (tasks as any[]).filter((t) => t.status === 'wip' && !t.archived);
		console.log(`  active wip: ${wipTasks.length}`);
		for (const t of wipTasks) {
			console.log(`    - ${t._id}  "${t.title}"  statusChangedAt=${t.statusChangedAt}  assignee._id=${t.assignee?._id}  username=${t.assignee?.username}`);
			const wipEntries = (t.activityLog ?? []).filter(
				(e: any) => e.action === 'status_change' && (e.details?.to === 'wip' || e.details?.from === 'wip')
			);
			console.log(`      activityLog status_change entries touching wip: ${wipEntries.length}`);
			for (const e of wipEntries.slice(-5)) {
				console.log(`        ${e.createdAt}  ${e.details?.from} → ${e.details?.to}`);
			}
		}

		const recentLog = (tasks as any[])
			.flatMap((t: any) =>
				(t.activityLog ?? [])
					.filter((e: any) => e.action === 'status_change' && (e.details?.to === 'wip' || e.details?.from === 'wip'))
					.map((e: any) => ({ taskId: t._id, title: t.title, ...e }))
			)
			.sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
			.slice(0, 10);
		console.log(`  last 10 WIP transitions across all his tasks:`);
		for (const e of recentLog) {
			console.log(`    ${e.createdAt}  ${e.details?.from} → ${e.details?.to}  "${e.title}"  (${e.taskId})`);
		}
	}

	console.log('\n=== Any task whose assignee.username contains "alejandr" but assignee._id is missing/mismatched ===');
	const orphan = await db
		.collection('kanban_tasks')
		.find({ 'assignee.username': { $regex: /alejandr/i } })
		.project({ _id: 1, title: 1, status: 1, assignee: 1, archived: 1 })
		.toArray();
	console.log(`  total: ${orphan.length}`);
	for (const t of orphan as any[]) {
		console.log(`  ${t._id}  "${t.title}"  status=${t.status}  archived=${t.archived}  assignee=${JSON.stringify(t.assignee)}`);
	}

	await mongoose.disconnect();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
