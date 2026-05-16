import { json } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { loadWipTimeline } from '$lib/server/kanban/analytics';
import type { RequestHandler } from './$types';

/**
 * Polling endpoint for the WIP Timeline widget. Returns the same shape as the
 * server load function would, scoped to a single day. Used for live updates.
 */
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	requirePermission(locals.user, 'kanban:read');

	const day = url.searchParams.get('day');
	const data = await loadWipTimeline(day);
	return json(data);
};
