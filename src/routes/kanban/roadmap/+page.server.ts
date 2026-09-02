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
import { connectDB, KanbanCanvasLayout, KanbanTask, AuditLog, generateId } from '$lib/server/db';
import { addLink, createKanbanItem, TransitionError } from '$lib/server/kanban/transition';
import { normalizeTags } from '$lib/server/kanban/tags';
import { computeRoadmap } from '$lib/server/kanban/schedule';
import { deriveChains } from '$lib/server/kanban/chains';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'kanban:read');
	await connectDB();

	const [roadmap, layoutDocs, candidateDocs, chains] = await Promise.all([
		computeRoadmap(),
		KanbanCanvasLayout.find({}).select('_id x y').lean(),
		// Chain picker source: everything a new milestone could plausibly wait
		// on. Done/declined work is excluded — gating on it anchors nothing.
		KanbanTask.find({ archived: false, status: { $nin: ['done', 'declined'] } })
			.select('_id trackingNumber title status itemType tags rank')
			.sort({ rank: 1 })
			.lean(),
		// KB2-39: bands = chains (milestone DAGs), labeled + linked to plans.
		deriveChains()
	]);

	return {
		roadmap: JSON.parse(JSON.stringify(roadmap)),
		chains: JSON.parse(JSON.stringify(chains)),
		pinned: JSON.parse(JSON.stringify(layoutDocs)) as { _id: string; x: number; y: number }[],
		linkCandidates: (candidateDocs as any[]).map((t) => ({
			id: String(t._id),
			trackingNumber: t.trackingNumber ?? null,
			title: t.title,
			status: t.status,
			itemType: t.itemType ?? 'deliverable',
			tags: t.tags ?? []
		})),
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

	/**
	 * Create a dated milestone from the roadmap itself, with its blocked_by
	 * chain wired at birth. Rides createKanbanItem — the same service the MCP
	 * capture path uses — so a UI milestone and an agent milestone are the
	 * same shape (Tier 1 'captured', rank appended, links cycle-checked,
	 * audited). The due date is the only HARD date the scheduler anchors to,
	 * so it is required here: an undated milestone anchors nothing.
	 */
	createMilestone: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'kanban:write');
		await connectDB();
		const fd = await request.formData();

		const title = fd.get('title')?.toString().trim();
		if (!title) return fail(400, { error: 'A milestone needs a title' });

		const dueRaw = fd.get('dueDate')?.toString().trim();
		if (!dueRaw || !/^\d{4}-\d{2}-\d{2}$/.test(dueRaw)) {
			return fail(400, { error: 'A milestone needs a due date — it is the date the backward pass anchors to' });
		}
		// Local midnight, matching the scheduler's parseLocalDate contract.
		const dueDate = new Date(dueRaw + 'T00:00:00');
		if (Number.isNaN(dueDate.getTime())) return fail(400, { error: 'That due date is not a real date' });

		// Same tag hygiene as every other capture path (trim, case-fold onto
		// the existing vocabulary, de-dupe).
		const tags = await normalizeTags(fd.get('tags')?.toString() ?? '');
		const blockedBy = [...new Set(fd.getAll('blockedBy').map((v) => v.toString()).filter(Boolean))];

		try {
			const task = await createKanbanItem({
				title,
				description: fd.get('description')?.toString().trim() || undefined,
				itemType: 'milestone',
				dueDate,
				tags,
				blockedBy,
				source: 'roadmap',
				actor: { username: locals.user.username, via: 'ui' }
			});
			return { success: true, createdMilestone: { id: String((task as any)._id), title } };
		} catch (e) {
			if (e instanceof TransitionError) return fail(400, { error: e.message });
			throw e;
		}
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
