import { json } from '@sveltejs/kit';
import { connectDB, KanbanTask } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import type { RequestHandler } from './$types';

/**
 * Tiny watermark endpoint: returns the max(updatedAt) over kanban_tasks. The
 * WipTimelineWidget polls this every couple of seconds and only re-fetches the
 * full timeline payload when this value advances. Lets us approximate
 * push-on-change without holding a long-lived SSE connection on Vercel.
 */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	requirePermission(locals.user, 'kanban:read');

	await connectDB();
	const latest = (await KanbanTask.findOne({})
		.sort({ updatedAt: -1 })
		.select('updatedAt')
		.lean()) as { updatedAt?: Date } | null;

	const mtime = latest?.updatedAt ? new Date(latest.updatedAt).getTime() : 0;
	return json({ mtime });
};
