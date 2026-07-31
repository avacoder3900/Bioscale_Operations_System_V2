/**
 * KB2-06 — the commitment ceremony. Only a human holding kanban:replenish
 * (or admin) commits; the page is read-only for everyone else and the
 * service enforces the permission again server-side.
 */
import { fail, redirect } from '@sveltejs/kit';
import { connectDB, AuditLog } from '$lib/server/db';
import { requirePermission, hasPermission, isAdmin } from '$lib/server/permissions';
import { replenish, demote, replenishmentStatus, ReplenishError } from '$lib/server/kanban/replenish';
import { TransitionError } from '$lib/server/kanban/transition';
import type { KanbanBoard } from '$lib/shared/kanban-status';
import type { PageServerLoad, Actions } from './$types';

function boardOf(url: URL): KanbanBoard {
	return url.searchParams.get('board') === 'software' ? 'software' : 'ops';
}

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'kanban:read');
	await connectDB();
	const board = boardOf(url);

	const status = await replenishmentStatus(board);

	// Recent replenishment events — the inspectable decision records.
	// tableName narrows to the {tableName, recordId} compound index — without it
	// this regex full-scans the audit log (Atlas query-targeting alert, 2026-07-31).
	const events = (await AuditLog.find({
		tableName: 'kanban_tasks',
		recordId: { $regex: /^replenishment:/ },
		'newData.board': board
	})
		.sort({ changedAt: -1 })
		.limit(10)
		.lean()) as any[];

	return {
		board,
		canReplenish: hasPermission(locals.user, 'kanban:replenish') || isAdmin(locals.user),
		status: JSON.parse(JSON.stringify(status)),
		events: JSON.parse(
			JSON.stringify(
				events.map((e) => ({
					id: e._id,
					by: e.changedBy,
					at: e.changedAt,
					promotedCount: e.newData?.promoted?.length ?? 0,
					rejectedCount: e.newData?.rejected?.length ?? 0,
					note: e.newData?.note ?? null
				}))
			)
		)
	};
};

export const actions: Actions = {
	// One replenishment event per commit — selected candidates, in order.
	commit: async ({ request, locals, url }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'kanban:write');
		await connectDB();
		const fd = await request.formData();
		const taskIds = fd.getAll('taskIds').map((v) => v.toString()).filter(Boolean);
		if (!taskIds.length) return fail(400, { error: 'Select at least one candidate to commit.' });
		const note = fd.get('note')?.toString() || undefined;

		try {
			const result = await replenish({
				taskIds,
				board: boardOf(url),
				actorUsername: locals.user.username,
				via: 'ui',
				note
			});
			return { replenishResult: JSON.parse(JSON.stringify(result)) };
		} catch (e) {
			if (e instanceof ReplenishError) {
				return fail(e.code === 'PERMISSION_DENIED' ? 403 : 400, { error: e.message, code: e.code });
			}
			if (e instanceof TransitionError) return fail(400, { error: e.message, code: e.code });
			throw e;
		}
	},

	demote: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'kanban:write');
		await connectDB();
		const fd = await request.formData();
		const taskId = fd.get('taskId')?.toString();
		const reason = fd.get('reason')?.toString();
		if (!taskId) return fail(400, { error: 'Missing taskId' });

		try {
			await demote({ taskId, reason: reason ?? '', actorUsername: locals.user.username, via: 'ui' });
		} catch (e) {
			if (e instanceof ReplenishError) {
				return fail(e.code === 'PERMISSION_DENIED' ? 403 : 400, { error: e.message, code: e.code });
			}
			if (e instanceof TransitionError) return fail(400, { error: e.message, code: e.code });
			throw e;
		}
		return { success: true };
	}
};

export const config = { maxDuration: 60 };
