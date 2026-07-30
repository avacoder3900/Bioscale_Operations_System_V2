/**
 * KB2-06 — Flow metrics view. Everything comes from the KB2-05 module, which
 * enforces the no-per-person constraint at the query layer: nothing on this
 * screen names a person, by construction.
 */
import { redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB } from '$lib/server/db';
import { flowMetrics } from '$lib/server/kanban/flow-metrics';
import type { KanbanBoard } from '$lib/shared/kanban-status';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'kanban:read');
	await connectDB();
	const board: KanbanBoard = url.searchParams.get('board') === 'software' ? 'software' : 'ops';

	const metrics = await flowMetrics(board);
	return { board, metrics: JSON.parse(JSON.stringify(metrics)) };
};

export const config = { maxDuration: 60 };
