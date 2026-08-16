/**
 * KB2-06 — "Queue": the Tier 2 default view. A horizontal single-lane column
 * board (Ready | In Progress | In Review | Waiting | Blocked | Done). Every
 * mutation goes through the transition service (or demote for commitment
 * unwinds) — zero direct status writes here. Quick capture lives on Inventory.
 * KB2-16: one board — tags carry the ops/software distinction.
 */
import { fail, redirect } from '@sveltejs/kit';
import { connectDB, KanbanTask } from '$lib/server/db';
import { requirePermission, hasPermission, isAdmin } from '$lib/server/permissions';
import { transitionTask, TransitionError } from '$lib/server/kanban/transition';
import { demote, ReplenishError } from '$lib/server/kanban/replenish';
import { getKanbanPolicy, queuePolicyOf } from '$lib/server/kanban/policy';
import { standingStatus } from '$lib/server/kanban/standing';
import { isKanbanStatus, type KanbanStatus } from '$lib/shared/kanban-status';
import type { PageServerLoad, Actions } from './$types';
import type { RequestEvent } from '@sveltejs/kit';

const DAY = 86400000;

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
		tags: (t.tags ?? []) as string[],
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

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'kanban:read');
	await connectDB();

	const policy = await getKanbanPolicy();
	const { readyCap, minOrderPoint } = queuePolicyOf(policy);
	const pullWindow: number = policy?.pullWindow ?? 3;

	// Supply loops (KB2-10/KB2-13) — the panel load IS a supply tick: anything
	// below its reorder point (standing targets + below-min parts) spawns its
	// auto-committed card here, before the task query, so it shows immediately.
	// Target CRUD lives on the policy page. Never let a supply failure break the board.
	let standing: Awaited<ReturnType<typeof standingStatus>> = { targets: [], partsReorder: [] };
	try {
		standing = await standingStatus({ spawn: true, actorUsername: 'system:supply' });
	} catch (e) {
		console.error('[kanban] supply tick failed:', e);
	}

	const weekAgo = new Date(Date.now() - 7 * DAY);
	const tasks = (await KanbanTask.find({
		archived: false,
		$or: [
			{ status: { $in: ['ready', 'wip', 'waiting', 'blocked', 'review'] } },
			{ status: 'done', $or: [{ completedDate: { $gte: weekAgo } }, { statusChangedAt: { $gte: weekAgo } }] }
		]
	})
		.sort({ rank: 1 })
		.lean()) as any[];

	const capturedCount = await KanbanTask.countDocuments({
		status: { $in: ['captured', 'processed'] },
		archived: false
	});
	const readyCount = tasks.filter((t) => t.status === 'ready').length;

	return {
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
	// Quick capture lives on the Inventory page — no 'create' action here.
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
