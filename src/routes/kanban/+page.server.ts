/**
 * KB2-06 — "The Queue": the Tier 2 default view. One flat, vertically-ordered
 * global queue per board. Every mutation goes through the transition service
 * (or demote for commitment unwinds) — zero direct status writes here.
 */
import { fail, redirect } from '@sveltejs/kit';
import { connectDB, KanbanTask, KanbanProject } from '$lib/server/db';
import { requirePermission, hasPermission, isAdmin } from '$lib/server/permissions';
import { transitionTask, createKanbanItem, TransitionError } from '$lib/server/kanban/transition';
import { demote, ReplenishError } from '$lib/server/kanban/replenish';
import { getKanbanPolicy, boardPolicyOf } from '$lib/server/kanban/policy';
import { standingStatus } from '$lib/server/kanban/standing';
import { isKanbanStatus, type KanbanBoard, type KanbanStatus } from '$lib/shared/kanban-status';
import type { PageServerLoad, Actions } from './$types';
import type { RequestEvent } from '@sveltejs/kit';

const DAY = 86400000;

function boardOf(url: URL): KanbanBoard {
	return url.searchParams.get('board') === 'software' ? 'software' : 'ops';
}

function mapTask(t: any) {
	return {
		id: t._id as string,
		title: t.title as string,
		status: t.status as KanbanStatus,
		rank: (t.rank ?? 0) as number,
		itemType: (t.itemType ?? 'deliverable') as string,
		classOfService: (t.classOfService ?? 'standard') as string,
		sizeClass: (t.sizeClass ?? null) as string | null,
		origin: (t.origin ?? 'planned') as string,
		projectName: (t.project?.name ?? null) as string | null,
		projectColor: (t.project?.color ?? null) as string | null,
		assigneeName: (t.assignee?.username ?? null) as string | null,
		blockedReason: (t.blockedReason ?? null) as string | null,
		waitingOn: (t.waitingOn ?? null) as string | null,
		waitingUntil: (t.waitingUntil ?? null) as string | null,
		waitingReason: (t.waitingReason ?? null) as string | null,
		dueDate: (t.dueDate ?? null) as string | null,
		completedDate: (t.completedDate ?? null) as string | null,
		daysInStatus: t.statusChangedAt
			? Math.floor((Date.now() - new Date(t.statusChangedAt).getTime()) / DAY)
			: 0
	};
}

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'kanban:read');
	await connectDB();
	const board = boardOf(url);

	const policy = await getKanbanPolicy();
	const { readyCap, minOrderPoint } = boardPolicyOf(policy, board);
	const pullWindow: number = policy?.pullWindow ?? 3;

	const weekAgo = new Date(Date.now() - 7 * DAY);
	const tasks = (await KanbanTask.find({
		board,
		archived: false,
		$or: [
			{ status: { $in: ['ready', 'wip', 'waiting', 'blocked', 'review'] } },
			{ status: 'done', $or: [{ completedDate: { $gte: weekAgo } }, { statusChangedAt: { $gte: weekAgo } }] }
		]
	})
		.sort({ rank: 1 })
		.lean()) as any[];

	// Supply panel (KB2-10) — read-only here; CRUD lives on the policy page.
	const standing = await standingStatus();

	const capturedCount = await KanbanTask.countDocuments({
		board,
		status: { $in: ['captured', 'processed'] },
		archived: false
	});
	const readyCount = tasks.filter((t) => t.status === 'ready').length;

	return {
		board,
		pullWindow,
		readyCap,
		minOrderPoint,
		readyCount,
		capturedCount,
		canReplenish: hasPermission(locals.user, 'kanban:replenish') || isAdmin(locals.user),
		standing: JSON.parse(JSON.stringify(standing)),
		tasks: JSON.parse(JSON.stringify(tasks.map(mapTask)))
	};
};

/**
 * Shared transition runner: buttons map 1:1 to named transitions; the
 * service's typed errors surface verbatim in the UI banner.
 */
async function runTransition(event: RequestEvent, forcedTo?: KanbanStatus) {
	const { locals, request } = event;
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'kanban:write');
	await connectDB();
	const fd = await request.formData();
	const taskId = fd.get('taskId')?.toString();
	const to = forcedTo ?? fd.get('to')?.toString();
	if (!taskId || !to) return fail(400, { error: 'Missing taskId or target status' });
	if (!isKanbanStatus(to)) return fail(400, { error: `'${to}' is not a valid status` });

	const reason = fd.get('reason')?.toString() || undefined;
	const waitingOn = fd.get('waitingOn')?.toString() || undefined;
	const waitingUntilRaw = fd.get('waitingUntil')?.toString();

	try {
		await transitionTask({
			taskId,
			to,
			actor: { username: locals.user.username, via: 'ui' },
			reason,
			waitingOn,
			waitingUntil: waitingUntilRaw ? new Date(waitingUntilRaw) : undefined
		});
	} catch (e) {
		if (e instanceof TransitionError) return fail(400, { error: e.message, code: e.code });
		throw e;
	}
	return { success: true };
}

export const actions: Actions = {
	// Quick capture: title only + optional project → a Tier 1 'captured' option.
	create: async ({ request, locals, url }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'kanban:write');
		await connectDB();
		const fd = await request.formData();
		const title = fd.get('title')?.toString();
		if (!title?.trim()) return fail(400, { error: 'Title is required' });

		const projectId = fd.get('projectId')?.toString();
		let project = null;
		if (projectId) {
			const p = (await KanbanProject.findById(projectId).lean()) as any;
			if (p) project = { _id: p._id, name: p.name, color: p.color };
		}

		try {
			await createKanbanItem({
				title,
				project,
				board: boardOf(url),
				actor: { username: locals.user.username, via: 'ui' }
			});
		} catch (e) {
			if (e instanceof TransitionError) return fail(400, { error: e.message, code: e.code });
			throw e;
		}
		return { success: true };
	},

	pull: (event) => runTransition(event, 'wip'),
	resume: (event) => runTransition(event, 'wip'),
	block: (event) => runTransition(event, 'blocked'),
	wait: (event) => runTransition(event, 'waiting'),
	move: (event) => runTransition(event),

	demote: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'kanban:write');
		await connectDB();
		const fd = await request.formData();
		const taskId = fd.get('taskId')?.toString();
		const reason = fd.get('reason')?.toString();
		if (!taskId) return fail(400, { error: 'Missing taskId' });

		try {
			await demote({
				taskId,
				reason: reason ?? '',
				actorUsername: locals.user.username,
				via: 'ui'
			});
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
