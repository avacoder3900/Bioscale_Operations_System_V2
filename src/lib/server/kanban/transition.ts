/**
 * THE single door for kanban status changes and item creation (KB2-01).
 *
 * Every path — UI actions, /api/kanban/move, agent API, MCP tools, crons —
 * calls transitionTask() / createKanbanItem(). No other code may write
 * task.status. This is what makes every invariant (tier crossing, WIP limits,
 * blocked-needs-reason) enforceable in exactly one place, and what guarantees
 * humans and Claude produce identical flow records.
 */
import { connectDB, KanbanTask, AuditLog, generateId } from '$lib/server/db';
import {
	isKanbanStatus,
	isTierCrossing,
	tierOf,
	STATUS_DATE_FIELD,
	type KanbanStatus,
	type KanbanItemType,
	type KanbanOrigin
} from '$lib/shared/kanban-status';
import { checkWipLimit } from './wip-limit.js';
import { getKanbanPolicy } from './policy.js';
import { renumberReady, checkMinOrderPoint } from './queue.js';

export type TransitionVia = 'ui' | 'mcp' | 'agent-api' | 'system';
export type TransitionActor = { username: string; via: TransitionVia };

export class TransitionError extends Error {
	code:
		| 'INVALID_STATUS'
		| 'TIER_CROSSING_FORBIDDEN'
		| 'WIP_LIMIT_EXCEEDED'
		| 'PULL_WINDOW'
		| 'REASON_REQUIRED'
		| 'WAITING_DEPENDENCY_REQUIRED'
		| 'NOT_FOUND';
	details?: unknown;
	constructor(code: TransitionError['code'], message: string, details?: unknown) {
		super(message);
		this.name = 'TransitionError';
		this.code = code;
		this.details = details;
	}
}

export interface TransitionOptions {
	taskId: string;
	to: KanbanStatus;
	actor: TransitionActor;
	reason?: string; // required for → blocked and → declined
	waitingOn?: string; // required for → waiting (named external dependency)
	waitingUntil?: Date; // required for → waiting
	/** ONLY the replenish/demote endpoints (KB2-02) may pass true. */
	allowTierCrossing?: boolean;
}

export async function transitionTask(opts: TransitionOptions) {
	const { taskId, to, actor } = opts;
	await connectDB();

	if (!isKanbanStatus(to)) {
		throw new TransitionError('INVALID_STATUS', `'${to}' is not a kanban status.`);
	}

	const task: any = await KanbanTask.findById(taskId);
	if (!task) throw new TransitionError('NOT_FOUND', `Task ${taskId} not found`);

	const from = task.status as KanbanStatus;
	if (from === to) return { task, changed: false as const };

	// The commitment point — the single most important invariant in KB2.
	if (isTierCrossing(from, to) && !opts.allowTierCrossing) {
		const direction = tierOf(to) === 2 ? 'promoted (Tier 1 → Tier 2)' : 'demoted (Tier 2 → Tier 1)';
		throw new TransitionError(
			'TIER_CROSSING_FORBIDDEN',
			`Task cannot be ${direction} through a normal update. Commitment-point crossings go through the replenishment path (kanban replenish/demote).`
		);
	}

	// Expedite is the emergency lane: exempt from personal WIP limits and the
	// pull window (hard system-wide cap enforced at replenish, KB2-04).
	if (to === 'wip' && task.classOfService !== 'expedite') {
		const incomingIsChore = task.itemType === 'chore' || task.classOfService === 'chore';
		const wip = await checkWipLimit(task.assignee?._id, taskId, incomingIsChore);
		if (!wip.ok) {
			throw new TransitionError(
				'WIP_LIMIT_EXCEEDED',
				wip.kind === 'chore_limit_exceeded'
					? `${wip.assignee} already has ${wip.currentCount} chore(s) in WIP (max ${wip.limit}). Chores are rationed so they don't eat the week.`
					: `${wip.assignee} is at their WIP limit (${wip.currentCount}/${wip.limit}). Finish or move an item out of WIP first.`,
				wip
			);
		}
	}

	// Pull policy (KB2-02): consume the queue from the top-N only. Preserves
	// real choice (skill/equipment match) inside a bounded window. Expedite
	// bypasses the window by definition; so do supply autopilot cards (KB2-13:
	// source standing-target/part-reorder) — supply work is always legitimate
	// to pull, at any rank.
	const isSupplyCard = task.source === 'standing-target' || task.source === 'part-reorder';
	if (from === 'ready' && to === 'wip' && task.classOfService !== 'expedite' && !isSupplyCard) {
		const policy = await getKanbanPolicy();
		const window = policy?.pullWindow ?? 3;
		if ((task.rank ?? 0) > window) {
			throw new TransitionError(
				'PULL_WINDOW',
				`Pull from the top ${window} of the ready queue (ranks 1–${window}); this item is rank ${task.rank}. If it should be worked now, reorder the queue first.`
			);
		}
	}

	if (to === 'blocked' && !opts.reason?.trim()) {
		throw new TransitionError('REASON_REQUIRED', "Moving to 'blocked' requires a reason (what is blocking us?).");
	}
	if (to === 'declined' && !opts.reason?.trim()) {
		throw new TransitionError('REASON_REQUIRED', "Declining requires a reason — declined items are kept for the record.");
	}
	if (to === 'waiting' && (!opts.waitingOn?.trim() || !opts.waitingUntil)) {
		throw new TransitionError(
			'WAITING_DEPENDENCY_REQUIRED',
			"Moving to 'waiting' requires a named external dependency (waitingOn) and a follow-up date (waitingUntil)."
		);
	}

	const now = new Date();
	task.status = to;
	task.statusChangedAt = now;

	const dateField = STATUS_DATE_FIELD[to];
	if (dateField) task[dateField] = now;
	if (tierOf(to) === 2 && !task.committedAt) task.committedAt = now;

	if (to === 'blocked') task.blockedReason = opts.reason!.trim();
	if (to === 'declined') task.declineReason = opts.reason!.trim();
	if (to === 'waiting') {
		task.waitingOn = opts.waitingOn!.trim();
		task.waitingUntil = opts.waitingUntil;
		if (opts.reason?.trim()) task.waitingReason = opts.reason.trim();
	}

	task.transitions.push({
		_id: generateId(),
		fromStatus: from,
		toStatus: to,
		changedBy: actor.username,
		via: actor.via,
		reason: opts.reason?.trim() || undefined,
		timestamp: now
	});
	task.activityLog.push({
		_id: generateId(),
		action: 'status_change',
		details: { from, to, reason: opts.reason?.trim() || undefined, via: actor.via },
		createdAt: now,
		createdBy: actor.username
	});

	await task.save();

	// Leaving the ready queue (pull, demote-by-service, done, etc.) → close the
	// rank gap and check queue depth. Entering ready happens only via replenish,
	// which does its own renumber/check.
	if (from === 'ready' && to !== 'ready') {
		await renumberReady();
		await checkMinOrderPoint();
	}

	await AuditLog.create({
		_id: generateId(),
		tableName: 'kanban_tasks',
		recordId: task._id,
		action: 'UPDATE',
		newData: { status: to, from, via: actor.via, reason: opts.reason?.trim() || undefined },
		changedBy: actor.username,
		changedAt: now
	});

	return { task, changed: true as const, from, to };
}

export interface CreateKanbanItemOptions {
	title: string;
	actor: TransitionActor;
	description?: string;
	assignee?: { _id: string; username: string } | null;
	itemType?: KanbanItemType;
	origin?: KanbanOrigin;
	spawnedFrom?: string;
	parentTaskId?: string;
	dueDate?: Date;
	tags?: string[];
	source?: string;
	sourceRef?: string;
	spike?: { question: string; timebox: { amount: number; unit: 'hours' | 'days' } };
}

/**
 * Standard creation path: everything starts as a Tier 1 'captured' option at
 * the bottom of the global Tier 1 rank order (KB2-16: one flat list). There is
 * deliberately no status argument — entering Tier 2 happens only through
 * replenishment (KB2-02).
 */
export async function createKanbanItem(opts: CreateKanbanItemOptions) {
	await connectDB();
	const now = new Date();

	if (opts.itemType === 'spike') {
		if (!opts.spike?.question?.trim() || !opts.spike?.timebox?.amount) {
			throw new TransitionError(
				'REASON_REQUIRED',
				'A spike cannot be created without a question and a timebox. If the question cannot be written, the uncertainty is not shaped enough to fund yet.'
			);
		}
	}

	// Append to the bottom of the global Tier 1 rank order.
	const last: any = await KanbanTask.findOne({
		status: { $in: ['captured', 'processed'] },
		archived: false
	})
		.sort({ rank: -1 })
		.select('rank')
		.lean();
	const rank = (last?.rank ?? 0) + 1;

	const task = await KanbanTask.create({
		_id: generateId(),
		title: opts.title.trim(),
		description: opts.description || undefined,
		status: 'captured',
		rank,
		itemType: opts.itemType ?? 'deliverable',
		origin: opts.origin ?? 'planned',
		spawnedFrom: opts.spawnedFrom || undefined,
		parentTaskId: opts.parentTaskId || undefined,
		assignee: opts.assignee ?? undefined,
		dueDate: opts.dueDate,
		tags: opts.tags ?? [],
		source: opts.source,
		sourceRef: opts.sourceRef,
		spike: opts.spike,
		statusChangedAt: now,
		createdBy: opts.actor.username,
		activityLog: [{
			_id: generateId(),
			action: 'created',
			details: { origin: opts.origin ?? 'planned', via: opts.actor.via, spawnedFrom: opts.spawnedFrom },
			createdAt: now,
			createdBy: opts.actor.username
		}]
	});

	await AuditLog.create({
		_id: generateId(),
		tableName: 'kanban_tasks',
		recordId: task._id,
		action: 'INSERT',
		newData: { title: opts.title.trim(), status: 'captured', origin: opts.origin ?? 'planned', via: opts.actor.via },
		changedBy: opts.actor.username,
		changedAt: now
	});

	return task;
}
