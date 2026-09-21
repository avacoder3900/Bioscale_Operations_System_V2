/**
 * One tub's full history (BUCKET-SYSTEM_PLAN.md §9.2): every cycle it has
 * held, the ledger, residual removals, and the cartridges each pass produced
 * (via CartridgeRecord.backing.bucketCycleId — the real link, never the bare
 * barcode, since the barcode repeats across passes).
 */
import { error, redirect } from '@sveltejs/kit';
import { connectDB, CartridgeRecord, LotRecord } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import { bucketHistory, STAGE_LABELS } from '$lib/server/services/bucket-service';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();

	const h = await bucketHistory(params.bucketId);
	if (!h) throw error(404, `Bucket ${params.bucketId} not found`);

	const cycleIds = h.cycles.map((c: any) => c._id);
	const [cartAgg, lots] = await Promise.all([
		cycleIds.length
			? CartridgeRecord.aggregate([
				{ $match: { 'backing.bucketCycleId': { $in: cycleIds } } },
				{ $group: { _id: '$backing.bucketCycleId', count: { $sum: 1 }, ids: { $push: '$_id' } } }
			]) as any as Promise<any[]>
			: Promise.resolve([]),
		cycleIds.length
			? LotRecord.find({ bucketCycleId: { $in: cycleIds } }).select('_id bucketCycleId outputLotNumber status quantityProduced').lean() as any as Promise<any[]>
			: Promise.resolve([])
	]);
	const cartsByCycle = new Map(cartAgg.map(r => [r._id, { count: r.count, ids: (r.ids as string[]).slice(0, 12) }]));
	const lotsByCycle = new Map<string, any[]>();
	for (const l of lots) {
		const arr = lotsByCycle.get(l.bucketCycleId) ?? [];
		arr.push({ lotId: l._id, outputLotNumber: l.outputLotNumber ?? null, status: l.status ?? null, quantityProduced: l.quantityProduced ?? null });
		lotsByCycle.set(l.bucketCycleId, arr);
	}

	const txByCycle = new Map<string, any[]>();
	const bucketTx: any[] = [];
	for (const t of h.transactions as any[]) {
		if (t.cycleId) {
			const arr = txByCycle.get(t.cycleId) ?? [];
			arr.push(t);
			txByCycle.set(t.cycleId, arr);
		} else {
			bucketTx.push(t);
		}
	}

	const iso = (d: any) => (d ? new Date(d).toISOString() : null);
	const tx = (t: any) => ({
		id: t._id,
		type: t.type,
		fromStage: t.fromStage ?? null,
		toStage: t.toStage ?? null,
		qtyBefore: t.qtyBefore ?? 0,
		qtyAfter: t.qtyAfter ?? 0,
		qtyDelta: t.qtyDelta ?? 0,
		reason: t.reason ?? null,
		journal: t.journal ?? null,
		relatedId: t.relatedId ?? null,
		operator: t.operator?.username ?? null,
		at: iso(t.createdAt)
	});

	return {
		bucket: {
			bucketId: h.bucket._id,
			barcode: h.bucket.barcode ?? null,
			state: h.bucket.state,
			cycleCount: h.bucket.cycleCount ?? 0,
			homeLocation: h.bucket.homeLocation ?? null,
			spotCheckPending: !!h.bucket.spotCheckPending,
			residualNote: h.bucket.residualNote ?? null,
			retiredAt: iso(h.bucket.retiredAt),
			retiredReason: h.bucket.retiredReason ?? null,
			createdAt: iso(h.bucket.createdAt),
			createdBy: h.bucket.createdBy?.username ?? null
		},
		cycles: (h.cycles as any[]).map(c => ({
			cycleId: c._id,
			cycleNumber: c.cycleNumber,
			stage: c.stage,
			stageLabel: STAGE_LABELS[c.stage as keyof typeof STAGE_LABELS] ?? c.stage,
			status: c.status,
			quantity: c.quantity,
			openedQty: c.openedQty,
			sourceLots: (c.sourceLots ?? []).map((l: any) => ({ partNumber: l.partNumber, lotId: l.lotId })),
			pressEquipmentName: c.pressEquipmentName ?? null,
			openedBy: c.openedBy?.username ?? null,
			openedAt: iso(c.openedAt),
			closedAt: iso(c.closedAt),
			emptyConfirmedBy: c.emptyConfirmedBy?.username ?? null,
			closedWithResidual: !!c.closedWithResidual,
			residualFound: (c.residualFound ?? []).map((r: any) => ({ qty: r.qty, stage: r.stage, disposition: r.disposition, at: iso(r.at), by: r.by?.username ?? null })),
			discrepancies: (c.discrepancies ?? []).map((d: any) => ({ type: d.type, qty: d.qty, note: d.note ?? null, at: iso(d.at) })),
			cartridges: cartsByCycle.get(c._id) ?? { count: 0, ids: [] },
			lots: lotsByCycle.get(c._id) ?? [],
			transactions: (txByCycle.get(c._id) ?? []).map(tx)
		})),
		bucketTransactions: bucketTx.map(tx),
		removals: (h.removals as any[]).map(r => ({
			id: r._id,
			cycleId: r.bucketCycleId ?? null,
			count: r.cartridgeCount ?? 0,
			journal: r.journal ?? r.reason ?? '',
			operator: r.operator?.username ?? null,
			at: iso(r.removedAt)
		}))
	};
};
