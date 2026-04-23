/**
 * Unified runs feed. Every production-relevant event becomes a UnifiedRun row
 * regardless of which underlying collection it lives in. This is the single
 * view backing the analytics page — filter it, aggregate it, chart it.
 *
 * Extend by adding a new fetcher function + wiring it into loadUnifiedRuns().
 */
import {
	LotRecord, WaxFillingRun, ReagentBatchRecord, LaserCutBatch,
	CartridgeRecord
} from '$lib/server/db';
import type { UnifiedRun, GlobalFilters, ProcessType } from './types.js';
import { inferShift } from './types.js';

function matchesFilters(r: UnifiedRun, f: GlobalFilters): boolean {
	if (f.processTypes && f.processTypes.length && !f.processTypes.includes(r.processType)) return false;
	if (f.operatorIds && f.operatorIds.length && r.operatorId && !f.operatorIds.includes(r.operatorId)) return false;
	if (f.robotIds && f.robotIds.length && r.robotId && !f.robotIds.includes(r.robotId)) return false;
	if (f.shifts && f.shifts.length) {
		const s = r.startTime ? inferShift(r.startTime) : null;
		if (!s || !f.shifts.includes(s)) return false;
	}
	if (f.inputLotBarcodes && f.inputLotBarcodes.length) {
		const barcodes = new Set((r.inputLots ?? []).map(l => l.barcode).filter(Boolean) as string[]);
		if (!f.inputLotBarcodes.some(b => barcodes.has(b))) return false;
	}
	return true;
}

function cycleTimeMinutes(start?: Date | null, end?: Date | null): number | null {
	if (!start || !end) return null;
	const ms = new Date(end).getTime() - new Date(start).getTime();
	if (ms <= 0) return null;
	return ms / 60000;
}

// ============================================================================
// Per-process fetchers
// ============================================================================

async function fetchWi01Runs(f: GlobalFilters): Promise<UnifiedRun[]> {
	const q: any = {};
	if (f.from || f.to) q.createdAt = {};
	if (f.from) q.createdAt.$gte = f.from;
	if (f.to) q.createdAt.$lte = f.to;

	const lots = await LotRecord.find(q).lean().catch(() => []);
	return (lots as any[])
		.filter(l => (l.processConfig?.processType ?? 'backing') === 'backing')
		.map(l => {
			const start = l.startTime ? new Date(l.startTime) : null;
			const end = l.finishTime ? new Date(l.finishTime) : null;
			return {
				runId: String(l._id),
				processType: 'wi-01' as ProcessType,
				status: l.status ?? 'unknown',
				operator: l.operator?.username ?? null,
				operatorId: l.operator?._id ?? null,
				robotId: null,
				robotName: null,
				deckId: null,
				startTime: start,
				endTime: end,
				cycleTimeMin: cycleTimeMinutes(start, end) ?? (l.cycleTime ? l.cycleTime / 60 : null),
				plannedCount: l.plannedQuantity ?? null,
				actualCount: l.quantityProduced ?? null,
				scrapCount: l.scrapCount ?? null,
				rejectedCount: null,
				acceptedCount: l.quantityProduced ?? null,
				inputLots: (l.inputLots ?? []).map((il: any) => ({ material: il.materialName, barcode: il.barcode })),
				outputLotId: String(l._id),
				outputBucketBarcode: l.bucketBarcode ?? null,
				abortReason: null,
				notes: l.notes ?? null,
				createdAt: new Date(l.createdAt ?? l.startTime ?? Date.now())
			};
		});
}

async function fetchWaxRuns(f: GlobalFilters): Promise<UnifiedRun[]> {
	const q: any = {};
	if (f.from || f.to) q.createdAt = {};
	if (f.from) q.createdAt.$gte = f.from;
	if (f.to) q.createdAt.$lte = f.to;
	if (f.robotIds && f.robotIds.length) q['robot._id'] = { $in: f.robotIds };

	const runs = await WaxFillingRun.find(q).lean().catch(() => []);
	// Pull per-run QC + scrap counts from CartridgeRecord so we can tally accept/reject/scrap
	const runIds = (runs as any[]).map(r => String(r._id));
	let qcByRun = new Map<string, { accepted: number; rejected: number; scrapped: number }>();
	if (runIds.length > 0) {
		const qcAgg = await CartridgeRecord.aggregate([
			{ $match: { 'waxFilling.runId': { $in: runIds } } },
			{ $group: {
				_id: '$waxFilling.runId',
				accepted: { $sum: { $cond: [{ $eq: ['$waxQc.status', 'Accepted'] }, 1, 0] } },
				rejected: { $sum: { $cond: [{ $eq: ['$waxQc.status', 'Rejected'] }, 1, 0] } },
				scrapped: { $sum: { $cond: [{ $eq: ['$status', 'scrapped'] }, 1, 0] } }
			} }
		]).catch(() => [] as any[]);
		for (const x of qcAgg as any[]) qcByRun.set(x._id, { accepted: x.accepted, rejected: x.rejected, scrapped: x.scrapped });
	}

	return (runs as any[]).map(r => {
		const start = r.runStartTime ? new Date(r.runStartTime) : null;
		const end = r.runEndTime ? new Date(r.runEndTime) : null;
		const qc = qcByRun.get(String(r._id)) ?? { accepted: 0, rejected: 0, scrapped: 0 };
		return {
			runId: String(r._id),
			processType: 'wax' as ProcessType,
			status: r.status ?? 'unknown',
			operator: r.operator?.username ?? null,
			operatorId: r.operator?._id ?? null,
			robotId: r.robot?._id ?? null,
			robotName: r.robot?.name ?? null,
			deckId: r.deckId ?? null,
			startTime: start,
			endTime: end,
			cycleTimeMin: cycleTimeMinutes(start, end),
			plannedCount: r.plannedCartridgeCount ?? null,
			actualCount: (r.cartridgeIds ?? []).length || null,
			scrapCount: qc.scrapped,
			rejectedCount: qc.rejected,
			acceptedCount: qc.accepted,
			inputLots: [
				...(r.waxSourceLot ? [{ material: 'Wax', barcode: r.waxSourceLot }] : []),
				...(r.waxTubeId ? [{ material: 'Wax Tube', barcode: r.waxTubeId }] : []),
				...(r.activeLotId ? [{ material: 'Backing Bucket', barcode: r.activeLotId }] : [])
			],
			outputLotId: null,
			abortReason: r.abortReason ?? null,
			notes: null,
			createdAt: new Date(r.createdAt ?? start ?? Date.now())
		};
	});
}

async function fetchReagentRuns(f: GlobalFilters): Promise<UnifiedRun[]> {
	const q: any = {};
	if (f.from || f.to) q.createdAt = {};
	if (f.from) q.createdAt.$gte = f.from;
	if (f.to) q.createdAt.$lte = f.to;
	if (f.robotIds && f.robotIds.length) q['robot._id'] = { $in: f.robotIds };
	if (f.assayIds && f.assayIds.length) q['assayType._id'] = { $in: f.assayIds };

	const runs = await ReagentBatchRecord.find(q).lean().catch(() => []);
	return (runs as any[]).map(r => {
		const start = r.runStartTime ? new Date(r.runStartTime) : null;
		const end = r.runEndTime ? new Date(r.runEndTime) : null;
		const carts = (r.cartridgesFilled ?? []) as any[];
		const accepted = carts.filter(c => c.inspectionStatus === 'Accepted').length;
		const rejected = carts.filter(c => c.inspectionStatus === 'Rejected').length;
		return {
			runId: String(r._id),
			processType: 'reagent' as ProcessType,
			status: r.status ?? 'unknown',
			operator: r.operator?.username ?? null,
			operatorId: r.operator?._id ?? null,
			robotId: r.robot?._id ?? null,
			robotName: r.robot?.name ?? null,
			deckId: r.deckId ?? null,
			startTime: start,
			endTime: end,
			cycleTimeMin: cycleTimeMinutes(start, end),
			plannedCount: r.cartridgeCount ?? null,
			actualCount: carts.length || null,
			scrapCount: null,
			rejectedCount: rejected,
			acceptedCount: accepted,
			inputLots: (r.tubeRecords ?? []).map((t: any) => ({ material: t.reagentName, barcode: t.sourceLotId })),
			outputLotId: null,
			assayName: r.assayType?.name ?? null,
			abortReason: r.abortReason ?? null,
			notes: null,
			createdAt: new Date(r.createdAt ?? start ?? Date.now())
		};
	});
}

async function fetchLaserCutBatches(f: GlobalFilters): Promise<UnifiedRun[]> {
	const q: any = {};
	if (f.from || f.to) q.createdAt = {};
	if (f.from) q.createdAt.$gte = f.from;
	if (f.to) q.createdAt.$lte = f.to;

	const batches = await LaserCutBatch.find(q).lean().catch(() => []);
	return (batches as any[]).map(b => {
		const start = b.startTime ? new Date(b.startTime) : new Date(b.createdAt);
		const end = b.finishTime ? new Date(b.finishTime) : null;
		return {
			runId: String(b._id),
			processType: 'laser-cut' as ProcessType,
			status: b.status ?? 'unknown',
			operator: b.operator?.username ?? null,
			operatorId: b.operator?._id ?? null,
			robotId: null,
			robotName: null,
			deckId: null,
			startTime: start,
			endTime: end,
			cycleTimeMin: cycleTimeMinutes(start, end),
			plannedCount: b.inputSheetCount ?? null,
			actualCount: b.outputStripCount ?? null,
			scrapCount: b.scrapCount ?? null,
			rejectedCount: null,
			acceptedCount: b.outputStripCount ?? null,
			inputLots: b.inputLotId ? [{ material: 'Thermoseal Roll', barcode: b.inputLotId }] : [],
			outputLotId: b.outputLotId ?? null,
			abortReason: null,
			notes: b.notes ?? null,
			createdAt: new Date(b.createdAt)
		};
	});
}

// ============================================================================
// Public API
// ============================================================================

export async function loadUnifiedRuns(f: GlobalFilters): Promise<UnifiedRun[]> {
	const [wi01, wax, reagent, laser] = await Promise.all([
		fetchWi01Runs(f),
		fetchWaxRuns(f),
		fetchReagentRuns(f),
		fetchLaserCutBatches(f)
	]);
	const all = [...wi01, ...wax, ...reagent, ...laser];
	return all.filter(r => matchesFilters(r, f))
		.sort((a, b) => (b.startTime?.getTime() ?? 0) - (a.startTime?.getTime() ?? 0));
}
