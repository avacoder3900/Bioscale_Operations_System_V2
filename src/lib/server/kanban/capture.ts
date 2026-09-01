/**
 * KB2-38 — one capture service for every surface (quick box, detailed page,
 * agent API, MCP).
 *
 *   captureTask = createKanbanItem → [processTask] → [replenish] → [reorder]
 *
 * `landing` says where the new item ends up; `position` says where in that
 * list. The gates are the existing ones, only front-loaded: a commit that
 * would be refused is refused BEFORE anything is written, so a failed commit
 * never leaves a half-created item behind. The crossing itself is still
 * replenish() — one audited replenishment event, same as the Tier 1 button.
 */
import { connectDB, KanbanTask } from '$lib/server/db';
import { createKanbanItem, TransitionError, type CreateKanbanItemOptions } from './transition.js';
import { processTask } from './process.js';
import {
	replenish,
	reorder,
	requireReplenisher,
	dorMissingFields,
	ReplenishError,
	type ReplenishResult
} from './replenish.js';
import { getKanbanPolicy, queuePolicyOf } from './policy.js';
import {
	SIZE_CLASSES,
	CLASSES_OF_SERVICE,
	type KanbanSizeClass,
	type KanbanClassOfService
} from '$lib/shared/kanban-status';

export const CAPTURE_LANDINGS = ['captured', 'processed', 'committed'] as const;
export type CaptureLanding = (typeof CAPTURE_LANDINGS)[number];

export function isCaptureLanding(s: unknown): s is CaptureLanding {
	return typeof s === 'string' && (CAPTURE_LANDINGS as readonly string[]).includes(s);
}

export interface CaptureTaskOptions extends CreateKanbanItemOptions {
	/** Where the item lands. Default 'captured' (plain Tier 1 capture). */
	landing?: CaptureLanding;
	/**
	 * 1-based slot in the landing list — Tier 1 order for captured/processed,
	 * the ready queue for committed. Omitted / 0 / NaN = bottom. Clamped.
	 */
	position?: number;
	/** Required for landing processed/committed (the capturer is the processor). */
	sizeClass?: KanbanSizeClass;
	classOfService?: KanbanClassOfService;
	/** Note on the replenishment event when committing. */
	commitNote?: string;
}

export interface CaptureTaskResult {
	taskId: string;
	trackingNumber: string | null;
	title: string;
	status: string;
	landing: CaptureLanding;
	/** Final 1-based position in the landing list (after placement). */
	position: number;
	replenish?: ReplenishResult;
}

function normalizePosition(p: unknown): number | undefined {
	if (typeof p !== 'number' || !Number.isFinite(p) || p < 1) return undefined;
	return Math.floor(p);
}

/**
 * Validate the shaping fields for a non-captured landing. Throws the same
 * errors processTask would, but before the item exists.
 */
function assertShaped(opts: CaptureTaskOptions) {
	if (!opts.sizeClass || !(SIZE_CLASSES as readonly string[]).includes(opts.sizeClass)) {
		throw new TransitionError(
			'REASON_REQUIRED',
			`Landing '${opts.landing}' needs a size class (${SIZE_CLASSES.join('/')}) — the capturer is processing this item.`
		);
	}
	if (!opts.classOfService || !(CLASSES_OF_SERVICE as readonly string[]).includes(opts.classOfService)) {
		throw new TransitionError(
			'REASON_REQUIRED',
			`Landing '${opts.landing}' needs a class of service (${CLASSES_OF_SERVICE.join('/')}).`
		);
	}
	if (opts.classOfService === 'fixed_date' && !opts.dueDate) {
		throw new TransitionError('REASON_REQUIRED', "classOfService 'fixed_date' requires a real external dueDate.");
	}
}

/** Ordered ids of the landing scope (the just-created item is already at the bottom). */
async function scopeIds(scope: 'tier1' | 'ready'): Promise<string[]> {
	const filter =
		scope === 'ready'
			? { status: 'ready', archived: false }
			: { status: { $in: ['captured', 'processed'] }, archived: false };
	const rows = (await KanbanTask.find(filter).sort({ rank: 1, createdAt: 1 }).select('_id').lean()) as any[];
	return rows.map((r) => String(r._id));
}

export async function captureTask(opts: CaptureTaskOptions): Promise<CaptureTaskResult> {
	await connectDB();
	const landing: CaptureLanding = opts.landing ?? 'captured';
	if (!isCaptureLanding(landing)) {
		throw new TransitionError('INVALID_STATUS', `Unknown landing '${String(opts.landing)}'.`);
	}
	const position = normalizePosition(opts.position);
	const scope: 'tier1' | 'ready' = landing === 'committed' ? 'ready' : 'tier1';

	// ---- front-loaded gates: nothing is written until these pass ----------
	if (landing !== 'captured') assertShaped(opts);

	if (landing === 'committed') {
		// The same checks replenish() applies, run against the would-be task
		// so a refusal costs nothing: who may commit, DoR, ready cap.
		await requireReplenisher(opts.actor.username);
		const wouldBe = {
			dor: opts.dor,
			sizeClass: opts.sizeClass,
			classOfService: opts.classOfService,
			dueDate: opts.dueDate,
			tags: opts.tags ?? [],
			itemType: opts.itemType ?? 'deliverable',
			spike: opts.spike
		};
		const missing = dorMissingFields(wouldBe);
		if (missing.length) {
			throw new ReplenishError(
				'DOR_INCOMPLETE',
				`Cannot capture straight to the Board — Definition of Ready incomplete: ${missing.join('; ')}`,
				{ missing }
			);
		}
		const { readyCap } = queuePolicyOf(await getKanbanPolicy());
		const readyCount = await KanbanTask.countDocuments({ status: 'ready', archived: false });
		if (readyCount >= readyCap) {
			throw new ReplenishError(
				'READY_CAP',
				`Ready queue is at its cap (${readyCount}/${readyCap}) — capture it processed instead, or demote something first.`,
				{ readyCount, readyCap }
			);
		}
	}

	// ---- create (always 'captured', bottom of Tier 1) -----------------------
	const { landing: _l, position: _p, sizeClass, classOfService, commitNote, ...createOpts } = opts;
	void _l;
	void _p;
	const created: any = await createKanbanItem(createOpts);
	const taskId = String(created._id);

	// ---- shape + process ----------------------------------------------------
	if (landing !== 'captured') {
		await processTask({
			taskId,
			actorUsername: opts.actor.username,
			via: opts.actor.via,
			sizeClass: sizeClass!,
			classOfService: classOfService!,
			dueDate: opts.dueDate,
			estimateDays: opts.estimateDays,
			effortDays: opts.effortDays
			// dor already stored by createKanbanItem
		});
	}

	// ---- commit -------------------------------------------------------------
	let replenishResult: ReplenishResult | undefined;
	if (landing === 'committed') {
		replenishResult = await replenish({
			taskIds: [taskId],
			actorUsername: opts.actor.username,
			via: opts.actor.via,
			note: commitNote ?? 'captured straight to the Board'
		});
		const rej = replenishResult.rejected.find((r) => r.taskId === taskId);
		if (rej) {
			// Pre-checks cover DoR/cap/permission; this is the rare residual
			// (expedite max, etc.). The item exists as 'processed' — say so.
			throw new ReplenishError(
				'NOT_ELIGIBLE',
				`Captured and processed, but not committed: ${rej.reason}`,
				{ taskId, replenish: replenishResult }
			);
		}
	}

	// ---- placement ----------------------------------------------------------
	let ids = await scopeIds(scope);
	let finalPos = ids.indexOf(taskId) + 1;
	if (position !== undefined && ids.length > 1) {
		ids = ids.filter((id) => id !== taskId);
		const j = Math.min(Math.max(position, 1), ids.length + 1) - 1;
		ids.splice(j, 0, taskId);
		if (j + 1 !== finalPos) {
			await reorder({ scope, orderedTaskIds: ids, actorUsername: opts.actor.username, via: opts.actor.via });
		}
		finalPos = j + 1;
	}

	// Record the intent on the card so the activity feed explains the jump.
	if (landing !== 'captured' || position !== undefined) {
		await KanbanTask.updateOne(
			{ _id: taskId, 'activityLog.action': 'created' },
			{ $set: { 'activityLog.$.details.landing': landing, 'activityLog.$.details.position': finalPos } }
		);
	}

	const fresh: any = await KanbanTask.findById(taskId).select('status trackingNumber title').lean();
	return {
		taskId,
		trackingNumber: fresh?.trackingNumber ?? created.trackingNumber ?? null,
		title: fresh?.title ?? created.title,
		status: fresh?.status ?? created.status,
		landing,
		position: finalPos,
		replenish: replenishResult
	};
}
