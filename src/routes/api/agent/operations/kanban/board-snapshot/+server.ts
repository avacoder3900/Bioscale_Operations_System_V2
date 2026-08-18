import { json } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB, KanbanTask } from '$lib/server/db';
import { ALL_STATUSES } from '$lib/shared/kanban-status';
import type { RequestHandler } from './$types';

// KB2-16: one board, every status is a column.
const COLUMNS = ALL_STATUSES;

export const GET: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await connectDB();

	const tasks = await KanbanTask.find({ archived: { $ne: true } })
		.select('_id title status rank sizeClass assignee dueDate tags activityLog statusChangedAt')
		.sort({ rank: 1 })
		.lean();

	const tasksByStatus: Record<string, any[]> = {};
	for (const col of COLUMNS) {
		tasksByStatus[col] = [];
	}

	const statusCounts: Record<string, number> = {};
	for (const col of COLUMNS) {
		statusCounts[col] = 0;
	}

	for (const t of tasks as any[]) {
		const status = t.status || 'captured';
		if (!tasksByStatus[status]) tasksByStatus[status] = [];
		tasksByStatus[status].push({
			id: t._id,
			title: t.title,
			status: t.status,
			rank: t.rank ?? 0,
			sizeClass: t.sizeClass ?? null,
			assignee: t.assignee,
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
