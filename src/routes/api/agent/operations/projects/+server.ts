import { json } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB, KanbanProject, KanbanTask } from '$lib/server/db';
import { ALL_STATUSES } from '$lib/shared/kanban-status';
import type { RequestHandler } from './$types';

function emptyCounts(): Record<string, number> {
	const counts: Record<string, number> = { total: 0 };
	for (const s of ALL_STATUSES) counts[s] = 0;
	return counts;
}

export const GET: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await connectDB();

	const [projects, tasks] = await Promise.all([
		KanbanProject.find().sort({ sortOrder: 1 }).lean(),
		KanbanTask.find({ archived: { $ne: true } })
			.select('project._id status').lean()
	]);

	// Build task counts per project
	const countsByProject: Record<string, Record<string, number>> = {};
	for (const t of tasks as any[]) {
		const pid = t.project?._id || 'unassigned';
		if (!countsByProject[pid]) {
			countsByProject[pid] = emptyCounts();
		}
		countsByProject[pid].total++;
		const s = t.status || 'captured';
		countsByProject[pid][s] = (countsByProject[pid][s] || 0) + 1;
	}

	return json({
		success: true,
		data: {
			projects: (projects as any[]).map(p => ({
				id: p._id,
				name: p.name,
				color: p.color,
				isActive: p.isActive,
				taskCounts: countsByProject[p._id] || emptyCounts()
			}))
		}
	});
};
