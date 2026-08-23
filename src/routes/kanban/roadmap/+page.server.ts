/**
 * KB2-29/KB2-30 — /kanban/roadmap: countdown cards + must-start list (KB2-29)
 * above the infinite-canvas dependency map (KB2-30, replaced the swimlane
 * timeline 2026-08-20). The canvas draws nodes from the KB2-28 scheduler
 * result (blockedBy edges, slack, critical chain) and merges pinned positions
 * from kanban_canvas_layout; anything unpinned gets dagre auto-layout
 * client-side.
 */
import { fail, redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, KanbanCanvasLayout, AuditLog, generateId } from '$lib/server/db';
import { addLink, TransitionError } from '$lib/server/kanban/transition';
import { computeRoadmap } from '$lib/server/kanban/schedule';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'kanban:read');
	await connectDB();

	const [roadmap, layoutDocs] = await Promise.all([
		computeRoadmap(),
		KanbanCanvasLayout.find({}).select('_id x y').lean()
	]);

	return {
		roadmap: JSON.parse(JSON.stringify(roadmap)),
		pinned: JSON.parse(JSON.stringify(layoutDocs)) as { _id: string; x: number; y: number }[],
		user: JSON.parse(JSON.stringify(locals.user))
	};
};

export const actions: Actions = {
	/**
	 * Persist a dragged node's position (shared layout). Deliberately NOT
	 * audit-logged — high-frequency presentation writes; pinnedBy keeps
	 * accountability (KB2-30 documented exception).
	 */
	pinNode: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'kanban:write');
		await connectDB();
		const fd = await request.formData();
		const taskId = fd.get('taskId')?.toString();
		const x = parseFloat(fd.get('x')?.toString() ?? '');
		const y = parseFloat(fd.get('y')?.toString() ?? '');
		if (!taskId || !Number.isFinite(x) || !Number.isFinite(y)) {
			return fail(400, { error: 'Missing taskId/x/y' });
		}
		await KanbanCanvasLayout.updateOne(
			{ _id: taskId },
			{ $set: { x, y, pinnedBy: locals.user.username } },
			{ upsert: true }
		);
		return { success: true };
	},

	/**
	 * KB2-37 — click-to-connect on the canvas: blockerId must finish before
	 * blockedId starts. Rides the addLink service (existence, self-link, dupe,
	 * blocking-cycle guard, audit + activity log) — identical protections to
	 * the task-page panel and MCP paths. Declared as blocked_by on the blocked
	 * task, consistent with existing wiring.
	 */
	addEdge: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'kanban:write');
		await connectDB();
		const fd = await request.formData();
		const blockerId = fd.get('blockerId')?.toString();
		const blockedId = fd.get('blockedId')?.toString();
		if (!blockerId || !blockedId) return fail(400, { error: 'Missing blockerId/blockedId' });
		try {
			const res = await addLink(
				blockedId,
				{ taskId: blockerId, type: 'blocked_by', note: 'wired on the roadmap canvas' },
				{ username: locals.user.username, via: 'ui' }
			);
			if (!res.added) return fail(400, { error: 'That dependency already exists' });
		} catch (e) {
			if (e instanceof TransitionError) return fail(400, { error: e.message });
			throw e;
		}
		return { success: true };
	},

	/** Clear ALL pins → next load re-runs auto-layout. Destroys a shared arrangement → audited. */
	relayout: async ({ locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'kanban:write');
		await connectDB();
		const { deletedCount } = await KanbanCanvasLayout.deleteMany({});
		await AuditLog.create({
			_id: generateId(),
			tableName: 'kanban_canvas_layout',
			recordId: 'relayout',
			action: 'DELETE',
			newData: { event: 'relayout', pinsCleared: deletedCount },
			changedBy: locals.user.username,
			changedAt: new Date()
		});
		return { success: true, cleared: deletedCount };
	}
};
