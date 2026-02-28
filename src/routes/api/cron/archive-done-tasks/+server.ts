import { json } from '@sveltejs/kit';
import { connectDB, KanbanTask, AuditLog } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async () => {
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
