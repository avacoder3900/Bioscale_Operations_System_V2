import { json } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB, KanbanProject, KanbanTask } from '$lib/server/db';
import type { RequestHandler } from './$types';

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
			countsByProject[pid] = { total: 0, backlog: 0, ready: 0, wip: 0, waiting: 0, done: 0 };
		}
		countsByProject[pid].total++;
		const s = t.status || 'backlog';
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
				taskCounts: countsByProject[p._id] || { total: 0, backlog: 0, ready: 0, wip: 0, waiting: 0, done: 0 }
			}))
		}
	});
};
