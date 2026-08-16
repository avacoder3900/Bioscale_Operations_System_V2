/**
 * KB2-02 — the commitment point.
 *
 * replenish() is the ONLY way an item crosses Tier 1 → Tier 2, demote() the
 * only way back. Only a human commits — including a human driving Claude:
 * callers resolve `actor` to a real active user holding kanban:replenish
 * (or admin:full). transitionTask() rejects tier crossings everywhere else.
 */
import { connectDB, KanbanTask, User, AuditLog, generateId } from '$lib/server/db';
import { hasPermission, isAdmin } from '$lib/server/permissions';
import { transitionTask, type TransitionVia } from './transition.js';
import { getKanbanPolicy, queuePolicyOf } from './policy.js';
import { renumberReady, checkMinOrderPoint } from './queue.js';

export class ReplenishError extends Error {
	code: 'ACTOR_INVALID' | 'PERMISSION_DENIED' | 'NOT_ELIGIBLE' | 'DOR_INCOMPLETE' | 'READY_CAP' | 'NOT_FOUND';
	details?: unknown;
	constructor(code: ReplenishError['code'], message: string, details?: unknown) {
		super(message);
		this.name = 'ReplenishError';
		this.code = code;
		this.details = details;
	}
}

/**
 * Resolve an actor username to a real, active user and require the
 * replenishment permission. The human driving Claude is the committer;
 * Claude is only the channel — so this runs for MCP calls too.
 */
export async function requireReplenisher(username: string | undefined | null): Promise<{ _id: string; username: string }> {
	if (!username?.trim()) {
		throw new ReplenishError('ACTOR_INVALID', 'Replenishment requires a named human actor (username). Only a human commits work.');
	}
	await connectDB();
	const user: any = await User.findOne({ username: username.trim().toLowerCase() })
		.select('username isActive roles')
		.lean();
	if (!user || user.isActive === false) {
		throw new ReplenishError('ACTOR_INVALID', `Actor '${username}' is not an active BIMS user.`);
	}
	if (!hasPermission(user, 'kanban:replenish') && !isAdmin(user)) {
		throw new ReplenishError('PERMISSION_DENIED', `${user.username} does not hold kanban:replenish.`);
	}
	return { _id: user._id, username: user.username };
}

/**
 * Definition-of-Ready check (KB2-03). The DoR is what makes the commitment
 * gate objective instead of a judgment call — replenish rejects with the
 * exact missing fields.
 */
export function dorMissingFields(task: any): string[] {
	const missing: string[] = [];
	if (!task.dor?.deliverable?.trim()) missing.push("dor.deliverable (state what will exist/be true when this is done, and how you'd verify it)");
	if (!task.sizeClass) missing.push('sizeClass (set at processing)');
	if (!task.classOfService) missing.push('classOfService (set at processing)');
	if (task.classOfService === 'fixed_date' && !task.dueDate) missing.push('dueDate (fixed_date items need a real external date)');
	// KB2-16: 'software' is a tag now, but the invariant survives — software
	// items still commit with a coding-agent handoff brief (KB2-08).
	if ((task.tags ?? []).includes('software') && !task.dor?.handoffBrief?.trim()) {
		missing.push('dor.handoffBrief (the coding-agent handoff brief — software items commit with one)');
	}
	if (task.itemType === 'spike') {
		if (!task.spike?.question?.trim()) missing.push('spike.question');
		if (!task.spike?.timebox?.amount) missing.push('spike.timebox');
	}
	return missing;
}

async function readyTasks() {
	return (await KanbanTask.find({ status: 'ready', archived: false })
		.sort({ rank: 1 })
		.select('_id title rank classOfService itemType')
		.lean()) as any[];
}

export interface ReplenishResult {
	eventId: string;
	promoted: { taskId: string; title: string; rank: number }[];
	rejected: { taskId: string; title?: string; reason: string }[];
	readyCount: number;
	readyCap: number;
}

/**
 * Promote Tier 1 options into the global ready queue, in the given order.
 * One replenishment event per call — the inspectable decision record.
 */
export async function replenish(opts: {
	taskIds: string[];
	actorUsername: string;
	via: TransitionVia;
	note?: string;
}): Promise<ReplenishResult> {
	const actor = await requireReplenisher(opts.actorUsername);
	const policy = await getKanbanPolicy();
	const { readyCap } = queuePolicyOf(policy);
	const eventId = generateId();
	const now = new Date();

	const promoted: ReplenishResult['promoted'] = [];
	const rejected: ReplenishResult['rejected'] = [];

	for (const taskId of opts.taskIds) {
		const task: any = await KanbanTask.findById(taskId).lean();
		if (!task) {
			rejected.push({ taskId, reason: 'not found' });
			continue;
		}
		if (task.status !== 'processed') {
			rejected.push({
				taskId,
				title: task.title,
				reason:
					task.status === 'captured'
						? "still 'captured' — process it first (size class + class of service are set at processing)"
						: `status '${task.status}' is not an uncommitted Tier 1 option`
			});
			continue;
		}
		const missing = dorMissingFields(task);
		if (missing.length) {
			rejected.push({ taskId, title: task.title, reason: `Definition of Ready incomplete: ${missing.join('; ')}` });
			continue;
		}
		// Expedite: hard system-wide cap on concurrently committed emergencies (KB2-04).
		if (task.classOfService === 'expedite') {
			const expediteMax = policy?.expedite?.systemMax ?? 1;
			const activeExpedite = await KanbanTask.countDocuments({
				classOfService: 'expedite',
				status: { $in: ['ready', 'wip', 'waiting', 'blocked', 'review'] },
				archived: false
			});
			if (activeExpedite >= expediteMax) {
				rejected.push({ taskId, title: task.title, reason: `expedite limit reached (${activeExpedite}/${expediteMax} system-wide) — a rising expedite rate is an upstream-planning signal, not bad luck` });
				continue;
			}
		}
		// Chore ceiling: chores are rationed — floor AND ceiling (KB2-04). A ban
		// would drive small work off the board; the ceiling stops it eating the week.
		if (task.itemType === 'chore' || task.classOfService === 'chore') {
			const chorePct = policy?.allocation?.chore ?? 15;
			const committed = await KanbanTask.countDocuments({
				status: { $in: ['ready', 'wip', 'waiting', 'blocked', 'review'] },
				archived: false
			});
			const chores = await KanbanTask.countDocuments({
				status: { $in: ['ready', 'wip', 'waiting', 'blocked', 'review'] },
				archived: false,
				$or: [{ itemType: 'chore' }, { classOfService: 'chore' }]
			});
			const ceiling = Math.max(1, Math.ceil(((committed + 1) * chorePct) / 100));
			if (chores + 1 > ceiling) {
				rejected.push({ taskId, title: task.title, reason: `chore allocation ceiling reached (${chores}/${ceiling} of committed work at ${chorePct}%)` });
				continue;
			}
		}
		const readyCount = await KanbanTask.countDocuments({ status: 'ready', archived: false });
		if (readyCount >= readyCap) {
			rejected.push({ taskId, title: task.title, reason: `ready cap reached (${readyCount}/${readyCap}) — demote something or raise the cap in policy` });
			continue;
		}

		await transitionTask({
			taskId,
			to: 'ready',
			actor: { username: actor.username, via: opts.via },
			allowTierCrossing: true
		});
		const rank = readyCount + 1;
		await KanbanTask.updateOne(
			{ _id: taskId },
			{ $set: { rank, replenishment: { eventId, promotedBy: actor.username, promotedAt: now } } }
		);
		promoted.push({ taskId, title: task.title, rank });
	}

	await renumberReady();
	await checkMinOrderPoint();

	await AuditLog.create({
		_id: generateId(),
		tableName: 'kanban_tasks',
		recordId: `replenishment:${eventId}`,
		action: 'UPDATE',
		newData: {
			event: 'replenishment',
			promoted: promoted.map((p) => p.taskId),
			rejected: rejected.map((r) => ({ taskId: r.taskId, reason: r.reason })),
			note: opts.note,
			via: opts.via
		},
		changedBy: actor.username,
		changedAt: now
	});

	const readyCount = await KanbanTask.countDocuments({ status: 'ready', archived: false });
	return { eventId, promoted, rejected, readyCount, readyCap };
}

/** Unwind a bad commitment: ready|waiting|blocked → processed. wip must leave wip first. */
export async function demote(opts: {
	taskId: string;
	actorUsername: string;
	via: TransitionVia;
	reason: string;
}): Promise<{ taskId: string; title: string }> {
	const actor = await requireReplenisher(opts.actorUsername);
	if (!opts.reason?.trim()) {
		throw new ReplenishError('NOT_ELIGIBLE', 'Demotion requires a reason — it is how a bad commitment gets unwound honestly.');
	}
	const task: any = await KanbanTask.findById(opts.taskId).lean();
	if (!task) throw new ReplenishError('NOT_FOUND', `Task ${opts.taskId} not found`);
	if (task.status === 'wip') {
		throw new ReplenishError('NOT_ELIGIBLE', 'A wip item must leave wip (finish, block, or wait) before it can be demoted — deliberate friction.');
	}
	if (!['ready', 'waiting', 'blocked', 'review'].includes(task.status)) {
		throw new ReplenishError('NOT_ELIGIBLE', `Status '${task.status}' is not a demotable Tier 2 state.`);
	}

	await transitionTask({
		taskId: opts.taskId,
		to: 'processed',
		actor: { username: actor.username, via: opts.via },
		allowTierCrossing: true,
		reason: opts.reason.trim()
	});
	// Back into Tier 1 at the bottom of the global rank order.
	const last: any = await KanbanTask.findOne({
		status: { $in: ['captured', 'processed'] },
		archived: false,
		_id: { $ne: opts.taskId }
	})
		.sort({ rank: -1 })
		.select('rank')
		.lean();
	await KanbanTask.updateOne({ _id: opts.taskId }, { $set: { rank: (last?.rank ?? 0) + 1 } });

	await renumberReady();
	await checkMinOrderPoint();
	return { taskId: opts.taskId, title: task.title };
}

/** Explicit, audited re-rank. Tier 2: scope='ready'. Tier 1: scope='tier1' (KB2-16: one flat list). */
export async function reorder(opts: {
	scope: 'ready' | 'tier1';
	orderedTaskIds: string[];
	actorUsername: string;
	via: TransitionVia;
}): Promise<{ reordered: number }> {
	// Ready-queue reordering is a commitment-order decision → replenisher permission.
	// Tier 1 ordering is ordinary management → kanban:write is checked by the endpoints.
	if (opts.scope === 'ready') await requireReplenisher(opts.actorUsername);
	await connectDB();

	const filter =
		opts.scope === 'ready'
			? { status: 'ready', archived: false }
			: { status: { $in: ['captured', 'processed'] }, archived: false };
	const inScope = (await KanbanTask.find(filter).select('_id').lean()) as any[];
	const inScopeIds = new Set(inScope.map((t) => String(t._id)));

	let r = 1;
	for (const id of opts.orderedTaskIds) {
		if (!inScopeIds.has(id)) continue;
		await KanbanTask.updateOne({ _id: id }, { $set: { rank: r++ } });
		inScopeIds.delete(id);
	}
	// Anything in scope but not in the provided order goes after, preserving relative order.
	if (inScopeIds.size) {
		const rest = (await KanbanTask.find({ _id: { $in: [...inScopeIds] } }).sort({ rank: 1 }).select('_id').lean()) as any[];
		for (const t of rest) await KanbanTask.updateOne({ _id: t._id }, { $set: { rank: r++ } });
	}

	await AuditLog.create({
		_id: generateId(),
		tableName: 'kanban_tasks',
		recordId: opts.scope === 'ready' ? 'reorder:ready' : 'reorder:tier1',
		action: 'UPDATE',
		newData: { event: 'reorder', order: opts.orderedTaskIds, via: opts.via },
		changedBy: opts.actorUsername,
		changedAt: new Date()
	});
	return { reordered: r - 1 };
}

/** The "should we replenish?" one-call: candidates, capacity, signals. */
export async function replenishmentStatus() {
	const policy = await getKanbanPolicy();
	const { readyCap, minOrderPoint } = queuePolicyOf(policy);
	const ready = await readyTasks();

	const candidates = (await KanbanTask.find({
		status: { $in: ['captured', 'processed'] },
		archived: false
	})
		.sort({ rank: 1, createdAt: 1 })
		.select('_id title status rank tags itemType classOfService sizeClass origin dor spike')
		.lean()) as any[];

	const wip = (await KanbanTask.find({ status: 'wip', archived: false })
		.select('classOfService')
		.lean()) as any[];
	const byClass: Record<string, number> = {};
	for (const t of wip) byClass[t.classOfService ?? 'standard'] = (byClass[t.classOfService ?? 'standard'] ?? 0) + 1;

	return {
		ready: { count: ready.length, cap: readyCap, minOrderPoint, belowMinOrderPoint: ready.length < minOrderPoint, queue: ready },
		wipByClassOfService: byClass,
		allocationTargetsPct: policy.allocation,
		candidates: candidates.map((c) => {
			const missing = dorMissingFields(c);
			return {
				taskId: c._id,
				title: c.title,
				status: c.status,
				tags: c.tags ?? [],
				rank: c.rank,
				itemType: c.itemType,
				classOfService: c.classOfService,
				sizeClass: c.sizeClass,
				origin: c.origin,
				dorComplete: missing.length === 0,
				dorMissing: missing
			};
		})
	};
}
