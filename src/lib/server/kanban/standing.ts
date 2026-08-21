/**
 * KB2-10 + KB2-13 — the supply loops. Live target-vs-actual from BIMS data;
 * below the reorder point → spawn exactly ONE card per target (idempotent),
 * plus a parts reorder sweep driven straight off PartDefinition.minimumOrderQty
 * (no per-part targets needed).
 *
 * KB2-13 (Jacob 2026-08-03): system-spawned supply cards are auto-shaped
 * (sizeClass/classOfService/dor.deliverable — or the linked template's shape)
 * and AUTO-COMMITTED straight to the bottom of the ready queue. This is a
 * deliberate, scoped exception to the KB2-02 human-only-replenishment rule:
 * the human decision was made once, when the target was configured. Supply
 * cards bypass the ready cap, the chore allocation ceiling, and the pull
 * window (transition.ts) — a stock dip must never be blocked by queue policy.
 * Human-created work still goes through replenishment. Per-target opt-out:
 * autoCommit:false restores exact KB2-10 behavior (captured option).
 *
 * Chemistry inventory (decision 3): 'reagent_stock' computes from the shared
 * research-v2 ReagentInventory collection (item-level docs, status
 * active/depleted/expired/discarded) — the chemistry wiring available today.
 * A dedicated BIMS chemical-inventory system does not exist yet; when it
 * lands, extend the metric registry with one new kind in computeActual() +
 * the StandingTarget enum + the MCP schema. That is the whole contract.
 */
import {
	connectDB,
	StandingTarget,
	KanbanTask,
	KanbanTemplate,
	CartridgeRecord,
	PartDefinition,
	ReagentInventory,
	generateId
} from '$lib/server/db';
import { createKanbanItem, transitionTask } from './transition.js';
import { renumberReady, checkMinOrderPoint } from './queue.js';

const SUPPLY_ACTOR = 'system:supply';

export async function computeActual(target: any): Promise<number | null> {
	const p = target.metric?.params ?? {};
	switch (target.metric?.kind) {
		case 'cartridge_phase_count': {
			const filter: any = {};
			if (Array.isArray(p.statuses) && p.statuses.length) filter.status = { $in: p.statuses };
			if (Array.isArray(p.skus) && p.skus.length) filter['sku.skuCode'] = { $in: p.skus };
			return CartridgeRecord.countDocuments(filter);
		}
		case 'part_stock': {
			if (!p.partId) return null;
			const part: any = await PartDefinition.findById(p.partId).select('inventoryCount').lean();
			return part?.inventoryCount ?? null;
		}
		case 'reagent_stock': {
			// research-v2 shared collection: one doc per physical reagent item.
			const filter: any = { status: { $in: Array.isArray(p.statuses) && p.statuses.length ? p.statuses : ['active'] } };
			if (p.catalogId) filter.catalogId = p.catalogId;
			if (p.variantKey) filter.variantKey = p.variantKey;
			if (p.type) filter.type = p.type;
			if (p.measure === 'volume') {
				const agg = await ReagentInventory.aggregate([
					{ $match: filter },
					{ $group: { _id: null, total: { $sum: { $ifNull: ['$volume', 0] } } } }
				]);
				return agg[0]?.total ?? 0;
			}
			return ReagentInventory.countDocuments(filter);
		}
		case 'manual':
			return typeof p.value === 'number' ? p.value : null;
		default:
			return null;
	}
}

/**
 * KB2-13 auto-commit: shape the freshly spawned card (DoR-complete without a
 * processing ceremony), then commit it to the BOTTOM of the global ready
 * queue as 'system:supply'. Deliberately no ready-cap / chore-allocation
 * check (decision 2) — supply cards are exempt from queue-entry policy.
 */
async function shapeAndCommit(opts: {
	taskId: string;
	shape: {
		itemType?: string;
		sizeClass: string;
		classOfService: string;
		dorDeliverable: string;
		dorHandoffBrief?: string;
		tags?: string[];
	};
	autoCommit: boolean;
}): Promise<void> {
	const $set: Record<string, unknown> = {
		sizeClass: opts.shape.sizeClass,
		classOfService: opts.shape.classOfService,
		'dor.deliverable': opts.shape.dorDeliverable
	};
	if (opts.shape.itemType) $set.itemType = opts.shape.itemType;
	if (opts.shape.dorHandoffBrief) $set['dor.handoffBrief'] = opts.shape.dorHandoffBrief;
	if (opts.shape.tags?.length) $set.tags = opts.shape.tags;
	await KanbanTask.updateOne({ _id: opts.taskId }, { $set });

	if (!opts.autoCommit) return; // KB2-10 behavior: stays captured, human commits.

	await transitionTask({
		taskId: opts.taskId,
		to: 'ready',
		actor: { username: SUPPLY_ACTOR, via: 'system' },
		allowTierCrossing: true
	});
	// Bottom of the global ready rank order (commit order); there is no pull
	// window, so position never blocks anyone from pulling it.
	const last: any = await KanbanTask.findOne({ status: 'ready', archived: false, _id: { $ne: opts.taskId } })
		.sort({ rank: -1 })
		.select('rank')
		.lean();
	await KanbanTask.updateOne(
		{ _id: opts.taskId },
		{
			$set: {
				rank: (last?.rank ?? 0) + 1,
				replenishment: { eventId: generateId(), promotedBy: SUPPLY_ACTOR, promotedAt: new Date() }
			}
		}
	);
	await renumberReady();
	await checkMinOrderPoint();
}

/** Spawn (and auto-commit) the build card for one below-reorder-point standing target. */
async function spawnStandingBuild(t: any, actual: number, actorUsername?: string): Promise<string> {
	const tpl: any = t.templateId ? await KanbanTemplate.findById(t.templateId).lean() : null;

	const created: any = await createKanbanItem({
		title: `Build ${t.batchSize} × ${t.name}`,
		description: `Standing supply target "${t.name}" dropped to ${actual} (reorder point ${t.reorderPoint}, target ${t.target}). Suggested batch: ${t.batchSize}.`,
		actor: { username: actorUsername ?? SUPPLY_ACTOR, via: 'system' },
		itemType: (tpl?.itemType ?? t.spawnItemType ?? 'deliverable') as any,
		origin: 'planned',
		source: 'standing-target',
		sourceRef: `standing:${t._id}`,
		tags: tpl?.tags ?? []
	});

	await shapeAndCommit({
		taskId: created._id,
		shape: tpl
			? {
					sizeClass: tpl.sizeClass,
					classOfService: tpl.classOfService ?? 'standard',
					dorDeliverable: tpl.dor?.deliverable ?? `${t.name} at or above ${t.target} (currently ${actual}); verify: recount`,
					dorHandoffBrief: tpl.dor?.handoffBrief
				}
			: {
					sizeClass: t.spawnSizeClass ?? 'short',
					classOfService: (t.spawnItemType ?? 'deliverable') === 'chore' ? 'chore' : 'standard',
					dorDeliverable: `${t.name} at or above ${t.target} (currently ${actual}); verify: recount`
				},
		autoCommit: t.autoCommit !== false
	});
	return created._id;
}

/** Spawn (and auto-commit) the reorder chore card for one below-minimum part. */
async function spawnPartReorder(part: any): Promise<string> {
	const created: any = await createKanbanItem({
		title: `Order ${part.minimumOrderQty} × ${part.partNumber} ${part.name ?? ''}`.trim(),
		description: `Part ${part.partNumber} (${part.name ?? 'unnamed'}) is at ${part.inventoryCount} on hand — at/below minimum order quantity ${part.minimumOrderQty}. Reorder batch: ${part.minimumOrderQty}${part.supplier ? ` from ${part.supplier}` : ''}.`,
		actor: { username: SUPPLY_ACTOR, via: 'system' },
		itemType: 'chore',
		origin: 'planned',
		source: 'part-reorder',
		sourceRef: `part-reorder:${part._id}`
	});
	await shapeAndCommit({
		taskId: created._id,
		shape: {
			sizeClass: 'short',
			classOfService: 'chore',
			dorDeliverable: `Order placed for ${part.minimumOrderQty} × ${part.partNumber}; stock back above ${part.minimumOrderQty} (currently ${part.inventoryCount}); verify: PO recorded + receipt transaction logged`
		},
		autoCommit: true // parts reorders have no per-part config — always autopilot (decision 4)
	});
	return created._id;
}

async function openSupplyCardId(sourceRef: string): Promise<string | null> {
	const open: any = await KanbanTask.findOne({ sourceRef, status: { $ne: 'done' }, archived: false })
		.select('_id status')
		.lean();
	return open?._id ?? null;
}

export interface StandingStatusRow {
	targetId: string;
	name: string;
	actual: number | null;
	target: number;
	reorderPoint: number;
	batchSize: number;
	belowReorderPoint: boolean;
	autoCommit: boolean;
	openOptionId: string | null;
}

export interface PartsReorderRow {
	partId: string;
	partNumber: string;
	name: string | null;
	inventoryCount: number;
	minimumOrderQty: number;
	openTaskId: string | null;
}

export interface SupplyStatus {
	targets: StandingStatusRow[];
	partsReorder: PartsReorderRow[];
}

/**
 * KB2-13 — parts reorder sweep. No per-part standing targets: the sweep reads
 * minimumOrderQty + inventoryCount straight off PartDefinition and spawns one
 * auto-committed "Order {part}" chore card per below-minimum part (idempotent
 * on sourceRef part-reorder:<partId>).
 */
export async function partsReorderSweep(opts?: { spawn?: boolean }): Promise<PartsReorderRow[]> {
	await connectDB();
	const parts = (await PartDefinition.find({
		isActive: { $ne: false },
		minimumOrderQty: { $gt: 0 },
		$expr: { $lte: ['$inventoryCount', '$minimumOrderQty'] }
	})
		.select('partNumber name inventoryCount minimumOrderQty supplier')
		.sort({ partNumber: 1 })
		.lean()) as any[];

	const rows: PartsReorderRow[] = [];
	for (const part of parts) {
		let openTaskId = await openSupplyCardId(`part-reorder:${part._id}`);
		if (!openTaskId && opts?.spawn) openTaskId = await spawnPartReorder(part);
		rows.push({
			partId: part._id,
			partNumber: part.partNumber,
			name: part.name ?? null,
			inventoryCount: part.inventoryCount ?? 0,
			minimumOrderQty: part.minimumOrderQty,
			openTaskId
		});
	}
	return rows;
}

/**
 * The supply loop tick: standing targets + the parts reorder sweep. Runs on
 * Queue-page load and the daily cron (both with spawn:true), and read-only
 * from the MCP/agent status path unless spawn is requested.
 */
export async function standingStatus(opts?: { spawn?: boolean; actorUsername?: string }): Promise<SupplyStatus> {
	await connectDB();
	const targets = (await StandingTarget.find({ active: true }).lean()) as any[];
	const rows: StandingStatusRow[] = [];

	for (const t of targets) {
		const actual = await computeActual(t);
		const below = actual !== null && actual < t.reorderPoint;

		let openOptionId = await openSupplyCardId(`standing:${t._id}`);
		if (below && !openOptionId && opts?.spawn) {
			openOptionId = await spawnStandingBuild(t, actual!, opts.actorUsername);
		}

		rows.push({
			targetId: t._id,
			name: t.name,
			actual,
			target: t.target,
			reorderPoint: t.reorderPoint,
			batchSize: t.batchSize,
			belowReorderPoint: below,
			autoCommit: t.autoCommit !== false,
			openOptionId
		});
	}

	const partsReorder = await partsReorderSweep({ spawn: opts?.spawn });
	return { targets: rows, partsReorder };
}

/**
 * KB2-13 event-driven trigger: called (fire-and-forget) by the inventory
 * transaction service after a stock decrement. Checks the part-reorder rule
 * for THAT part plus any active part_stock standing targets pointing at it.
 * Must never throw into the caller.
 */
export async function checkSupplyForPart(partDefinitionId: string): Promise<void> {
	try {
		await connectDB();
		const part: any = await PartDefinition.findById(partDefinitionId)
			.select('partNumber name inventoryCount minimumOrderQty supplier isActive')
			.lean();
		if (!part) return;

		if (
			part.isActive !== false &&
			(part.minimumOrderQty ?? 0) > 0 &&
			(part.inventoryCount ?? 0) <= part.minimumOrderQty &&
			!(await openSupplyCardId(`part-reorder:${part._id}`))
		) {
			await spawnPartReorder(part);
		}

		const targets = (await StandingTarget.find({
			active: true,
			'metric.kind': 'part_stock',
			'metric.params.partId': partDefinitionId
		}).lean()) as any[];
		for (const t of targets) {
			const actual = await computeActual(t);
			if (actual !== null && actual < t.reorderPoint && !(await openSupplyCardId(`standing:${t._id}`))) {
				await spawnStandingBuild(t, actual);
			}
		}
	} catch (e) {
		console.error('[kanban/standing] checkSupplyForPart failed:', e);
	}
}
