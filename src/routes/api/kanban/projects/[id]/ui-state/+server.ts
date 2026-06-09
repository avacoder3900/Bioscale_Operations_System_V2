import { json } from '@sveltejs/kit';
import { connectDB, KanbanProject } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import type { RequestHandler } from './$types';

/**
 * Persist a project's UI state (board section fold + backlog accordion fold).
 * Global state — visible to all kanban:read users, mutable by kanban:write.
 *
 * Body: { collapsed?: boolean, backlogCollapsed?: boolean }
 *
 * Partial — only the provided fields are written. Sending an empty body 400s.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	requirePermission(locals.user, 'kanban:write');
	await connectDB();

	const body = await request.json().catch(() => ({}));
	const update: { collapsed?: boolean; backlogCollapsed?: boolean } = {};
	if (typeof body.collapsed === 'boolean') update.collapsed = body.collapsed;
	if (typeof body.backlogCollapsed === 'boolean') update.backlogCollapsed = body.backlogCollapsed;

	if (Object.keys(update).length === 0) {
		return json({ error: 'No valid fields. Provide collapsed and/or backlogCollapsed.' }, { status: 400 });
	}

	const result = await KanbanProject.updateOne({ _id: params.id }, { $set: update });
	if (result.matchedCount === 0) return json({ error: 'Project not found' }, { status: 404 });

	return json({ success: true, ...update });
};
