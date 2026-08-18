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
import { normalizeTags } from './tags.js';

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
	/** Sugar for links of type 'blocked_by' (MCP-IMPROVEMENTS P1-4). */
	blockedBy?: string[];
}

/**
 * Cycle guard for the blocking graph (MCP-IMPROVEMENTS P1-4). Edges are
 * "blocker → blocked". `blocks` on A pointing at B is A→B; `blocked_by` on A
 * pointing at B is B→A. Adding an edge X→Y is illegal if Y already reaches X.
 * The board is ~100 active tasks, so a plain DFS over the live blocking edges
 * is cheap and keeps this obviously correct.
 */
async function assertNoBlockingCycle(
	newEdges: Array<{ blocker: string; blocked: string }>
): Promise<void> {
	if (!newEdges.length) return;
	for (const e of newEdges) {
		if (e.blocker === e.blocked) {
			throw new TransitionError('REASON_REQUIRED', 'A task cannot block itself.');
		}
	}
	const holders = (await KanbanTask.find({
		archived: { $ne: true },
		'links.type': { $in: ['blocks', 'blocked_by'] }
	})
		.select('_id links')
		.lean()) as any[];

	const adj = new Map<string, Set<string>>();
	const add = (from: string, to: string) => {
		if (!adj.has(from)) adj.set(from, new Set());
		adj.get(from)!.add(to);
	};
	for (const t of holders) {
		for (const l of t.links ?? []) {
			if (l.type === 'blocks') add(t._id, l.taskId);
			else if (l.type === 'blocked_by') add(l.taskId, t._id);
		}
	}
	for (const e of newEdges) add(e.blocker, e.blocked);

	// For each new edge X→Y, a path Y ⇝ X means a cycle.
	for (const e of newEdges) {
		const stack = [e.blocked];
		const seen = new Set<string>();
		while (stack.length) {
			const cur = stack.pop()!;
			if (cur === e.blocker) {
				throw new TransitionError(
					'REASON_REQUIRED',
					`Blocking cycle: ${e.blocker} → ${e.blocked} would make ${e.blocked} (transitively) block ${e.blocker}. Dependencies must be acyclic.`
				);
			}
			if (seen.has(cur)) continue;
			seen.add(cur);
			for (const nxt of adj.get(cur) ?? []) stack.push(nxt);
		}
	}
}

/**
 * Validate declared links and stamp them for storage. Links are stored ONLY on
 * the declaring task; the inverse edge is derived on read (see readLinks), so
 * there is no second write that can fail and leave the pair inconsistent.
 * `ownerTaskId` is the declaring task when known (update path) — for creates
 * the new id is passed in so the cycle guard can reason about it.
 */
async function resolveLinks(
	declared: CreateKanbanItemOptions['links'],
	username: string,
	now: Date,
	ownerTaskId?: string
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

	if (ownerTaskId) {
		if (unique.some((l) => l.taskId === ownerTaskId)) {
			throw new TransitionError('REASON_REQUIRED', 'A task cannot be linked to itself.');
		}
		await assertNoBlockingCycle(
			unique
				.filter((l) => l.type === 'blocks' || l.type === 'blocked_by')
				.map((l) =>
					l.type === 'blocks'
						? { blocker: ownerTaskId, blocked: l.taskId }
						: { blocker: l.taskId, blocked: ownerTaskId }
				)
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

	const [resolved] = await resolveLinks([{ ...link, type }], actor.username, now, taskId);

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

/** Max parent-chain depth (root = 0). Milestone → component → sub-component is plenty. */
export const MAX_PARENT_DEPTH = 3;

/**
 * Re-parent an existing task (MCP-IMPROVEMENTS P1-5). `null` detaches. The
 * parent must exist; no self-parenting; no cycles (walk the parent chain);
 * depth ≤ MAX_PARENT_DEPTH counting the deepest descendant of the moved task.
 * Deliberately NO status coupling — a captured milestone may parent ready
 * components. Audited on both sides.
 */
export async function setParent(taskId: string, parentTaskId: string | null, actor: TransitionActor) {
	await connectDB();
	const now = new Date();
	const task: any = await KanbanTask.findById(taskId).select('_id parentTaskId title').lean();
	if (!task) throw new TransitionError('NOT_FOUND', `Task ${taskId} not found.`);
	const previous: string | null = task.parentTaskId ?? null;
	if ((parentTaskId ?? null) === previous) return { changed: false as const, parentTaskId: previous };

	if (parentTaskId) {
		if (parentTaskId === taskId) throw new TransitionError('REASON_REQUIRED', 'A task cannot be its own parent.');
		const parent: any = await KanbanTask.findById(parentTaskId).select('_id parentTaskId title').lean();
		if (!parent) throw new TransitionError('NOT_FOUND', `Parent task ${parentTaskId} not found.`);

		// Walk up from the proposed parent: hitting `taskId` means a cycle.
		// Also measures the parent's depth for the depth cap.
		let depthAbove = 1; // parent itself is one level above task
		let cursor: any = parent;
		const seen = new Set<string>([taskId]);
		while (cursor?.parentTaskId) {
			if (cursor.parentTaskId === taskId || seen.has(cursor.parentTaskId)) {
				throw new TransitionError('REASON_REQUIRED', `Re-parenting ${taskId} under ${parentTaskId} would create a cycle.`);
			}
			seen.add(cursor.parentTaskId);
			depthAbove++;
			cursor = await KanbanTask.findById(cursor.parentTaskId).select('_id parentTaskId').lean();
		}

		// Depth of the moved subtree below `taskId`.
		let depthBelow = 0;
		let frontier = [taskId];
		while (frontier.length) {
			const kids = (await KanbanTask.find({ parentTaskId: { $in: frontier } }).select('_id').lean()) as any[];
			if (!kids.length) break;
			depthBelow++;
			frontier = kids.map((k) => k._id);
			if (depthAbove + depthBelow > MAX_PARENT_DEPTH) break;
		}
		if (depthAbove + depthBelow > MAX_PARENT_DEPTH) {
			throw new TransitionError(
				'REASON_REQUIRED',
				`Re-parenting would exceed the maximum nesting depth of ${MAX_PARENT_DEPTH} (parent chain ${depthAbove} + subtree ${depthBelow}).`
			);
		}
	}

	await KanbanTask.updateOne(
		{ _id: taskId },
		{
			$set: { parentTaskId: parentTaskId ?? undefined },
			...(parentTaskId ? {} : { $unset: { parentTaskId: '' } }),
			$push: {
				activityLog: {
					_id: generateId(),
					action: parentTaskId ? 'reparented' : 'detached_from_parent',
					details: { from: previous, to: parentTaskId, via: actor.via },
					createdAt: now,
					createdBy: actor.username
				}
			}
		}
	);
	for (const pid of [previous, parentTaskId].filter((x): x is string => Boolean(x))) {
		await KanbanTask.updateOne(
			{ _id: pid },
			{
				$push: {
					activityLog: {
						_id: generateId(),
						action: pid === parentTaskId ? 'child_attached' : 'child_detached',
						details: { childTaskId: taskId, via: actor.via },
						createdAt: now,
						createdBy: actor.username
					}
				}
			}
		);
	}
	await AuditLog.create({
		_id: generateId(),
		tableName: 'kanban_tasks',
		recordId: taskId,
		action: 'UPDATE',
		oldData: { parentTaskId: previous },
		newData: { parentTaskId: parentTaskId ?? null, via: actor.via },
		changedFields: ['parentTaskId'],
		changedBy: actor.username,
		changedAt: now
	});
	return { changed: true as const, parentTaskId: parentTaskId ?? null, previous };
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

	// The id is allocated up front so declared links can be cycle-checked
	// against the task that will own them.
	const newId = generateId();

	// KB2-20: resolve declared links before insert. A link to a task that does
	// not exist is a data error, not a silent no-op — fail the create so the
	// caller learns the id is wrong instead of shipping a dangling edge.
	// `blockedBy` (P1-4 sugar) folds into blocked_by links here.
	const declaredLinks = [
		...(opts.links ?? []),
		...(opts.blockedBy ?? []).map((taskId) => ({ taskId, type: 'blocked_by' as KanbanLinkType }))
	];
	const links = await resolveLinks(declaredLinks, opts.actor.username, now, newId);

	// P1-3: every capture path gets tag hygiene (trim, case-fold onto the
	// existing vocabulary, de-dupe) — the vocabulary can't fork by casing.
	const tags = await normalizeTags(opts.tags ?? []);

	// Allocated before insert so the number is on the card from the first read.
	// If the counter is unreachable the create still proceeds unnumbered rather
	// than losing the option — backfill-tracking-numbers.ts closes the gap.
	let trackingNumber: string | undefined;
	try {
		trackingNumber = await nextTrackingNumber('task');
	} catch (err) {
		console.error('[kanban] tracking number allocation failed, creating unnumbered', err);
	}

	const dor =
		opts.dor?.deliverable?.trim() || opts.dor?.handoffBrief?.trim()
			? {
					deliverable: opts.dor.deliverable?.trim() || undefined,
					handoffBrief: opts.dor.handoffBrief?.trim() || undefined
				}
			: undefined;

	const task = await KanbanTask.create({
		_id: newId,
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
		tags,
		source: opts.source,
		sourceRef: opts.sourceRef,
		spike: opts.spike,
		dor,
		links,
		statusChangedAt: now,
		createdBy: opts.actor.username,
		activityLog: [{
			_id: generateId(),
			action: 'created',
			details: {
				origin: opts.origin ?? 'planned',
				via: opts.actor.via,
				spawnedFrom: opts.spawnedFrom,
				// Born shaped: DoR written at capture, not at processing.
				...(dor ? { dorSetAtCapture: Object.keys(dor).filter((k) => (dor as any)[k]) } : {})
			},
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
