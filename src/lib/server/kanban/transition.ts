/**
 * THE single door for kanban status changes and item creation (KB2-01).
 *
 * Every path — UI actions, /api/kanban/move, agent API, MCP tools, crons —
 * calls transitionTask() / createKanbanItem(). No other code may write
 * task.status. This is what makes every invariant (tier crossing, WIP limits,
 * blocked-needs-reason) enforceable in exactly one place, and what guarantees
 * humans and Claude produce identical flow records.
 */
import { connectDB, KanbanTask, AuditLog, generateId, nextTrackingNumber } from '$lib/server/db';
import {
	isKanbanStatus,
	isTierCrossing,
	tierOf,
	STATUS_DATE_FIELD,
	isKanbanLinkType,
	LINK_INVERSE,
	LINK_LABEL,
	type KanbanStatus,
	type KanbanItemType,
	type KanbanOrigin,
	type KanbanLinkType
} from '$lib/shared/kanban-status';
import { checkWipLimit } from './wip-limit.js';
import { renumberReady, checkMinOrderPoint } from './queue.js';

export type TransitionVia = 'ui' | 'mcp' | 'agent-api' | 'system';
export type TransitionActor = { username: string; via: TransitionVia };

export class TransitionError extends Error {
	code:
		| 'INVALID_STATUS'
		| 'TIER_CROSSING_FORBIDDEN'
		| 'WIP_LIMIT_EXCEEDED'
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
		const direction = tierOf(to) === 2 ? 'promoted (Tier 1 → Board)' : 'demoted (Board → Tier 1)';
		throw new TransitionError(
			'TIER_CROSSING_FORBIDDEN',
			`Task cannot be ${direction} through a normal update. Commitment-point crossings go through the replenishment path (kanban replenish/demote).`
		);
	}

	// Expedite is the emergency lane: exempt from personal WIP limits (its
	// hard system-wide cap is enforced at replenish, KB2-04). There is no pull
	// window — any ready task may be pulled; WIP is the only gate on starting.
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

	// Pull policy (KB2-02) removed: the ready queue is pull-anywhere. Any ready
	// card may be pulled to wip regardless of rank. Rank survives as the
	// recommended order — a suggestion the puller is free to ignore — and WIP
	// limits remain the real constraint on how much is in flight at once.

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
	/**
	 * Optional Definition-of-Ready fields at capture. A Tier 1 option may carry
	 * its deliverable from birth; processing pre-fills from it rather than
	 * asking twice. Still not required until replenishment (KB2-02 DoR floor).
	 */
	dor?: { deliverable?: string; handoffBrief?: string };
	/**
	 * KB2-20: links to declare at birth. This is how "a task spawns the task it
	 * needs" arrives already wired — the caller passes the originating task and
	 * the relationship, and the new card comes back linked and selectable.
	 */
	links?: Array<{ taskId: string; type?: KanbanLinkType; note?: string }>;
}

/**
 * Validate declared links and stamp them for storage. Links are stored ONLY on
 * the declaring task; the inverse edge is derived on read (see readLinks), so
 * there is no second write that can fail and leave the pair inconsistent.
 */
async function resolveLinks(
	declared: CreateKanbanItemOptions['links'],
	username: string,
	now: Date
): Promise<Array<{ _id: string; taskId: string; type: KanbanLinkType; note?: string; createdAt: Date; createdBy: string }>> {
	if (!declared?.length) return [];

	// De-dupe on (taskId, type) so a double-click cannot stack identical edges.
	const seen = new Set<string>();
	const unique = declared.filter((l) => {
		const key = `${l.taskId}::${l.type ?? 'relates_to'}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});

	for (const l of unique) {
		if (l.type && !isKanbanLinkType(l.type)) {
			throw new TransitionError('INVALID_STATUS', `Unknown link type '${l.type}'.`);
		}
	}

	const ids = unique.map((l) => l.taskId);
	const found = await KanbanTask.find({ _id: { $in: ids } }).select('_id').lean();
	const foundIds = new Set(found.map((t: any) => t._id));
	const missing = ids.filter((id) => !foundIds.has(id));
	if (missing.length) {
		throw new TransitionError(
			'NOT_FOUND',
			`Cannot link to task(s) that do not exist: ${missing.join(', ')}.`
		);
	}

	return unique.map((l) => ({
		_id: generateId(),
		taskId: l.taskId,
		type: l.type ?? 'relates_to',
		note: l.note?.trim() || undefined,
		createdAt: now,
		createdBy: username
	}));
}

/**
 * Read a task's full link set: its own declared edges plus the inverse of every
 * edge other tasks declared against it. Callers get one uniform list and never
 * need to know which side happens to hold the stored row.
 */
export async function readLinks(taskId: string) {
	await connectDB();

	const [self, inbound]: [any, any[]] = await Promise.all([
		KanbanTask.findById(taskId).select('links').lean(),
		KanbanTask.find({ 'links.taskId': taskId, archived: false })
			.select('_id trackingNumber title status links')
			.lean()
	]);

	const own = (self?.links ?? []).map((l: any) => ({
		linkId: l._id,
		taskId: l.taskId,
		type: l.type as KanbanLinkType,
		note: l.note,
		direction: 'declared' as const,
		ownerTaskId: taskId
	}));

	const derived = inbound.flatMap((t: any) =>
		(t.links ?? [])
			.filter((l: any) => l.taskId === taskId)
			.map((l: any) => ({
				linkId: l._id,
				taskId: t._id,
				type: LINK_INVERSE[l.type as KanbanLinkType] ?? 'relates_to',
				note: l.note,
				direction: 'derived' as const,
				ownerTaskId: t._id
			}))
	);

	const all = [...own, ...derived];
	if (!all.length) return [];

	// Hydrate the far side so the UI can render a labelled, clickable chip
	// without a second round trip.
	const others: any[] = await KanbanTask.find({ _id: { $in: all.map((l) => l.taskId) } })
		.select('_id trackingNumber title status itemType')
		.lean();
	const byId = new Map(others.map((t: any) => [t._id, t]));

	return all.map((l) => {
		const other = byId.get(l.taskId);
		return {
			...l,
			label: LINK_LABEL[l.type as KanbanLinkType] ?? l.type,
			trackingNumber: other?.trackingNumber ?? null,
			title: other?.title ?? '(deleted task)',
			status: other?.status ?? null,
			itemType: other?.itemType ?? null
		};
	});
}

/**
 * Add a link to an existing task. Self-links and duplicates are rejected rather
 * than quietly collapsing, so the caller sees what actually happened.
 */
export async function addLink(
	taskId: string,
	link: { taskId: string; type?: KanbanLinkType; note?: string },
	actor: TransitionActor
) {
	await connectDB();
	const now = new Date();

	if (link.taskId === taskId) {
		throw new TransitionError('REASON_REQUIRED', 'A task cannot be linked to itself.');
	}

	const task: any = await KanbanTask.findById(taskId).select('links').lean();
	if (!task) throw new TransitionError('NOT_FOUND', `Task ${taskId} not found.`);

	const type = link.type ?? 'relates_to';
	const existing = (task.links ?? []).find((l: any) => l.taskId === link.taskId && l.type === type);
	if (existing) return { added: false as const, linkId: existing._id };

	const [resolved] = await resolveLinks([{ ...link, type }], actor.username, now);

	await KanbanTask.findByIdAndUpdate(taskId, {
		$push: {
			links: resolved,
			activityLog: {
				_id: generateId(),
				action: 'link_added',
				details: { taskId: link.taskId, type, via: actor.via },
				createdAt: now,
				createdBy: actor.username
			}
		}
	});

	await AuditLog.create({
		_id: generateId(),
		tableName: 'kanban_tasks',
		recordId: taskId,
		action: 'UPDATE',
		newData: { link: { taskId: link.taskId, type }, via: actor.via },
		changedBy: actor.username,
		changedAt: now
	});

	return { added: true as const, linkId: resolved._id };
}

/** Remove a declared link by its subdocument id. Derived edges are not removable
 *  from this side — the owning task has to drop them, which readLinks makes obvious. */
export async function removeLink(taskId: string, linkId: string, actor: TransitionActor) {
	await connectDB();
	const now = new Date();

	const res = await KanbanTask.findByIdAndUpdate(
		taskId,
		{
			$pull: { links: { _id: linkId } },
			$push: {
				activityLog: {
					_id: generateId(),
					action: 'link_removed',
					details: { linkId, via: actor.via },
					createdAt: now,
					createdBy: actor.username
				}
			}
		},
		{ new: true }
	)
		.select('_id')
		.lean();

	if (!res) throw new TransitionError('NOT_FOUND', `Task ${taskId} not found.`);

	await AuditLog.create({
		_id: generateId(),
		tableName: 'kanban_tasks',
		recordId: taskId,
		action: 'UPDATE',
		newData: { removedLinkId: linkId, via: actor.via },
		changedBy: actor.username,
		changedAt: now
	});

	return { removed: true as const };
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

	// KB2-20: resolve declared links before insert. A link to a task that does
	// not exist is a data error, not a silent no-op — fail the create so the
	// caller learns the id is wrong instead of shipping a dangling edge.
	const links = await resolveLinks(opts.links, opts.actor.username, now);

	// Allocated before insert so the number is on the card from the first read.
	// If the counter is unreachable the create still proceeds unnumbered rather
	// than losing the option — backfill-tracking-numbers.ts closes the gap.
	let trackingNumber: string | undefined;
	try {
		trackingNumber = await nextTrackingNumber('task');
	} catch (err) {
		console.error('[kanban] tracking number allocation failed, creating unnumbered', err);
	}

	const task = await KanbanTask.create({
		_id: generateId(),
		trackingNumber,
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
		dor:
			opts.dor?.deliverable?.trim() || opts.dor?.handoffBrief?.trim()
				? {
						deliverable: opts.dor.deliverable?.trim() || undefined,
						handoffBrief: opts.dor.handoffBrief?.trim() || undefined
					}
				: undefined,
		links,
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
