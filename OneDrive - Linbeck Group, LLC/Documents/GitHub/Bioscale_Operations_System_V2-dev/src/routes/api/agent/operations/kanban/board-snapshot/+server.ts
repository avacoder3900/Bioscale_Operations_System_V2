import { json } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB, KanbanTask, KanbanProject } from '$lib/server/db';
import type { RequestHandler } from './$types';

const COLUMNS = ['blocked', 'backlog', 'ready', 'wip', 'waiting', 'done'] as const;

export const GET: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await connectDB();

	const [projects, tasks] = await Promise.all([
		KanbanProject.find({ isActive: true }).sort({ sortOrder: 1 }).lean(),
		KanbanTask.find({ archived: { $ne: true } })
			.select('_id title status prioritized assignee project dueDate tags sortOrder activityLog statusChangedAt')
			.sort({ sortOrder: 1 })
			.lean()
	]);

	const tasksByStatus: Record<string, any[]> = {};
	for (const col of COLUMNS) {
		tasksByStatus[col] = [];
	}

	const statusCounts: Record<string, number> = {};
	for (const col of COLUMNS) {
		statusCounts[col] = 0;
	}

	for (const t of tasks as any[]) {
		const status = t.status || 'backlog';
		if (!tasksByStatus[status]) tasksByStatus[status] = [];
		tasksByStatus[status].push({
			id: t._id,
			title: t.title,
			status: t.status,
			prioritized: t.prioritized ?? false,
			assignee: t.assignee,
			project: t.project,
			dueDate: t.dueDate,
			tags: t.tags,
			recentActivity: (t.activityLog || []).slice(-5).map((a: any) => ({
				action: a.action,
				details: a.details,
				createdAt: a.createdAt,
				createdBy: a.createdBy
			}))
		});
		statusCounts[status] = (statusCounts[status] || 0) + 1;
	}

	return json({
		success: true,
		data: {
			projects: (projects as any[]).map(p => ({ id: p._id, name: p.name, color: p.color })),
			columns: COLUMNS.map(status => ({
				status,
				tasks: tasksByStatus[status] || []
			})),
			summary: {
				total: (tasks as any[]).length,
				byStatus: statusCounts
			}
		}
	});
};
