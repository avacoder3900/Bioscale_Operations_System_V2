/**
 * KB2-10 — standing-work supply loop. Live target-vs-actual from BIMS data;
 * below the reorder point → spawn exactly ONE captured option per target
 * (idempotent: no new option while an un-done one exists). The option then
 * flows through the normal commitment point like everything else — the panel
 * just makes the need continuously visible.
 */
import { connectDB, StandingTarget, KanbanTask, CartridgeRecord, PartDefinition } from '$lib/server/db';
import { createKanbanItem } from './transition.js';

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
		case 'manual':
			return typeof p.value === 'number' ? p.value : null;
		default:
			return null;
	}
}

export interface StandingStatusRow {
	targetId: string;
	name: string;
	actual: number | null;
	target: number;
	reorderPoint: number;
	batchSize: number;
	belowReorderPoint: boolean;
	openOptionId: string | null;
}

export async function standingStatus(opts?: { spawn?: boolean; actorUsername?: string }): Promise<StandingStatusRow[]> {
	await connectDB();
	const targets = (await StandingTarget.find({ active: true }).lean()) as any[];
	const rows: StandingStatusRow[] = [];

	for (const t of targets) {
		const actual = await computeActual(t);
		const below = actual !== null && actual < t.reorderPoint;

		const open: any = await KanbanTask.findOne({
			sourceRef: `standing:${t._id}`,
			status: { $ne: 'done' },
			archived: false
		})
			.select('_id')
			.lean();

		let openOptionId: string | null = open?._id ?? null;

		if (below && !openOptionId && opts?.spawn) {
			const created: any = await createKanbanItem({
				title: `Build ${t.batchSize} × ${t.name}`,
				description: `Standing supply target "${t.name}" dropped to ${actual} (reorder point ${t.reorderPoint}, target ${t.target}). Suggested batch: ${t.batchSize}.`,
				actor: { username: opts.actorUsername ?? 'system', via: 'system' },
				board: t.board ?? 'ops',
				itemType: t.spawnItemType ?? 'deliverable',
				origin: 'planned',
				source: 'standing-target',
				sourceRef: `standing:${t._id}`
			});
			openOptionId = created._id;
		}

		rows.push({
			targetId: t._id,
			name: t.name,
			actual,
			target: t.target,
			reorderPoint: t.reorderPoint,
			batchSize: t.batchSize,
			belowReorderPoint: below,
			openOptionId
		});
	}
	return rows;
}
