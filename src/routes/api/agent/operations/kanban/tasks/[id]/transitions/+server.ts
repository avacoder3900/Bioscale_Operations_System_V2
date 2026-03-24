import { json, error } from '@sveltejs/kit';
import { connectDB, KanbanTask } from '$lib/server/db';
import { requireAgentApiKey } from '$lib/server/api-auth';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ request, params }) => {
	requireAgentApiKey(request);
	await connectDB();

	const { id } = params;
	const task = await KanbanTask.findById(id).select('_id title status transitions').lean() as any;
	if (!task) throw error(404, 'Task not found');

	return json({
		success: true,
		data: {
			taskId: task._id,
			title: task.title,
			currentStatus: task.status,
			transitions: (task.transitions || []).map((t: any) => ({
				id: t._id,
				fromStatus: t.fromStatus,
				toStatus: t.toStatus,
				changedBy: t.changedBy,
				timestamp: t.timestamp
			}))
		}
	});
};
