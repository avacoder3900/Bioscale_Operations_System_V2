/**
 * Read-only diagnostic: find tasks moved to 'done' today and report whether
 * they should appear on today's WIP timeline. A task should paint cells if it
 * has a wip→done (or wip→anything) transition stamped today.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

const URI = process.env.MONGODB_URI!;

function startOfDayLocal(): Date {
	const d = new Date();
	d.setHours(0, 0, 0, 0);
	return d;
}

async function main() {
	await mongoose.connect(URI);
	const db = mongoose.connection.db!;

	const today = startOfDayLocal();
	console.log(`Local-day start: ${today.toISOString()}`);
	console.log(`Now:             ${new Date().toISOString()}`);

	// Tasks whose status is done AND whose statusChangedAt is today.
	const candidates = await db
		.collection('kanban_tasks')
		.find({ status: 'done', statusChangedAt: { $gte: today } })
		.project({ _id: 1, title: 1, status: 1, archived: 1, archivedAt: 1, assignee: 1, statusChangedAt: 1, activityLog: 1 })
		.toArray();

	console.log(`\n=== Tasks done today: ${candidates.length} ===`);
	for (const t of candidates as any[]) {
		const log = (t.activityLog ?? [])
			.filter((e: any) => e.action === 'status_change' && e.details?.to)
			.map((e: any) => ({ to: e.details.to, from: e.details.from, t: new Date(e.createdAt).getTime() }))
			.sort((a: any, b: any) => a.t - b.t);

		// Re-walk to find wip intervals
		const intervals: { enter: number; exit: number | null }[] = [];
		let open: number | null = null;
		for (const tr of log) {
			if (tr.to === 'wip' && open === null) open = tr.t;
			else if (tr.to !== 'wip' && open !== null) {
				intervals.push({ enter: open, exit: tr.t });
				open = null;
			}
		}
		if (open !== null && t.status === 'wip') intervals.push({ enter: open, exit: null });

		const todayMs = today.getTime();
		const overlappingToday = intervals.filter((iv) => {
			const exit = iv.exit ?? Date.now();
			return exit > todayMs && iv.enter < todayMs + 86400000;
		});

		const shouldShow = overlappingToday.length > 0;
		const marker = shouldShow ? '✓ should show' : '✗ no overlap';
		console.log(
			`  ${marker}  ${t._id}  archived=${t.archived}  assignee=${t.assignee?.username ?? '—'}  "${t.title.slice(0, 60)}"`
		);
		if (!shouldShow) {
			console.log(`     statusChangedAt=${t.statusChangedAt}  intervals=${JSON.stringify(intervals)}`);
		}
		if (shouldShow && overlappingToday.length > 0) {
			for (const iv of overlappingToday) {
				const enter = new Date(iv.enter).toLocaleString();
				const exit = iv.exit ? new Date(iv.exit).toLocaleString() : 'still in wip';
				console.log(`     wip-interval: ${enter} → ${exit}`);
			}
		}
	}

	// Sanity: how many active (not archived) tasks have status=wip?
	const activeWip = await db.collection('kanban_tasks').countDocuments({ status: 'wip', archived: false });
	console.log(`\nActive WIP right now: ${activeWip}`);

	await mongoose.disconnect();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
