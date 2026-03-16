import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { connectDB, KanbanTask, AuditLog } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	const key = request.headers.get('x-api-key') || request.headers.get('x-agent-api-key') || request.headers.get('authorization')?.replace('Bearer ', '');
	if (!env.AGENT_API_KEY || key !== env.AGENT_API_KEY) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}
	await connectDB();

	const result = await KanbanTask.updateMany(
		{ status: 'done', archived: false },
		{ $set: { archived: true, archivedAt: new Date() } }
	);

	await AuditLog.create({
		tableName: 'kanban_tasks', recordId: 'cron-bulk',
		action: 'UPDATE', newData: { archived: true, count: result.modifiedCount },
		changedBy: 'system-cron'
	});

	return json({ success: true, archivedCount: result.modifiedCount });
};
