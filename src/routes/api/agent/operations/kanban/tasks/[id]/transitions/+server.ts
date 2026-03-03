import { json, error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { connectDB, KanbanTask } from '$lib/server/db';
import type { RequestHandler } from './$types';

function requireApiKey(request: Request) {
	const key = request.headers.get('x-api-key') || request.headers.get('x-agent-api-key') || request.headers.get('authorization')?.replace('Bearer ', '');
	if (!env.AGENT_API_KEY || key !== env.AGENT_API_KEY) {
		throw error(401, 'Invalid or missing API key');
	}
}

export const GET: RequestHandler = async ({ request, params }) => {
	requireApiKey(request);
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
