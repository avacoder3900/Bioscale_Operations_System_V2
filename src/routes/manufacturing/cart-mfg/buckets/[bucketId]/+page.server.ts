/**
 * One tub's full history (BUCKET-SYSTEM_PLAN.md §9.2): every cycle it has
 * held, the ledger, residual removals, and the cartridges each pass produced
 * (via CartridgeRecord.backing.bucketCycleId — the real link, never the bare
 * barcode, since the barcode repeats across passes).
 */
import { error, fail, redirect } from '@sveltejs/kit';
import { connectDB, CartridgeRecord, LotRecord } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import { bucketHistory, voidCycle, retireBucket, BucketError, STAGE_LABELS } from '$lib/server/services/bucket-service';
import type { Actions, PageServerLoad } from './$types';

function isBucketAdmin(user: App.Locals['user']): boolean {
	return !!user?.roles.some(r => r.permissions.includes('manufacturing:admin') || r.permissions.includes('admin:full'));
}

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
				{ $match: { $or: [{ 'bucket.cycleId': { $in: cycleIds } }, { 'backing.bucketCycleId': { $in: cycleIds } }] } },
				// wentOn = carts that left the bucket for wax filling (or further). 'backing' is
				// still a bucket stage, so a backed cart in the tub does not count.
				{ $group: { _id: { $ifNull: ['$bucket.cycleId', '$backing.bucketCycleId'] }, count: { $sum: 1 }, ids: { $push: '$_id' }, wentOn: { $sum: { $cond: [{ $and: [{ $in: ['$status', ['barcoded', 'raw', 'unpressed', 'pressed', 'backing', 'scrapped', 'voided']] }, { $not: ['$backing.movedToOvenAt'] }] }, 0, 1] } } } }
			]) as any as Promise<any[]>
			: Promise.resolve([]),
		cycleIds.length
			? LotRecord.find({ bucketCycleId: { $in: cycleIds } }).select('_id bucketCycleId outputLotNumber status quantityProduced').lean() as any as Promise<any[]>
			: Promise.resolve([])
	]);
	const cartsByCycle = new Map(cartAgg.map(r => [r._id, { count: r.count, wentOn: r.wentOn ?? 0, ids: (r.ids as string[]).slice(0, 12) }]));
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
		canVoid: isBucketAdmin(locals.user),
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
			stageLabel: STAGE_LABELS[c.stage as keyof typeof STAGE_LABELS] ?? (c.stage === 'qr_pending' ? 'QR Scan-In Pending (v1)' : c.stage),
			cartridgeIds: (c.cartridgeIds ?? []) as string[],
			status: c.status,
			quantity: c.quantity,
			openedQty: c.openedQty,
			sourceLots: (c.sourceLots ?? []).map((l: any) => ({ partNumber: l.partNumber, lotId: l.lotId })),
			openedBy: c.openedBy?.username ?? null,
			openedAt: iso(c.openedAt),
			closedAt: iso(c.closedAt),
			emptyConfirmedBy: c.emptyConfirmedBy?.username ?? null,
			closedWithResidual: !!c.closedWithResidual,
			voidedAt: iso(c.voidedAt),
			voidedBy: c.voidedBy?.username ?? null,
			voidReason: c.voidReason ?? null,
			residualFound: (c.residualFound ?? []).map((r: any) => ({ qty: r.qty, stage: r.stage, disposition: r.disposition, at: iso(r.at), by: r.by?.username ?? null })),
			discrepancies: (c.discrepancies ?? []).map((d: any) => ({ type: d.type, qty: d.qty, note: d.note ?? null, at: iso(d.at) })),
			cartridges: cartsByCycle.get(c._id) ?? { count: 0, wentOn: 0, ids: [] },
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
			at: iso(r.removedAt),
			voided: !!r.voidedAt
		}))
	};
};

export const actions: Actions = {
	/**
	 * Void a pass that never really happened (test data / wrong lot) and return
	 * what it took from inventory. Admin only — it moves real inventory numbers.
	 */
	voidPass: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		if (!isBucketAdmin(locals.user)) {
			return fail(403, { voidPass: { error: 'Voiding a pass requires manufacturing:admin' } });
		}
		await connectDB();
		const d = await request.formData();
		const cycleId = String(d.get('cycleId') ?? '');
		try {
			const r = await voidCycle({
				cycleId,
				reason: String(d.get('reason') ?? ''),
				user: { _id: locals.user._id, username: locals.user.username }
			});
			return { voidPass: { success: true, ...r } };
		} catch (e) {
			if (e instanceof BucketError) return fail(e.status, { voidPass: { error: e.message, cycleId } });
			throw e;
		}
	},

	/** Retire this bucket (kill the label). Admin only; the tub must be empty. */
	retire: async ({ request, locals, params }) => {
		if (!locals.user) redirect(302, '/login');
		if (!isBucketAdmin(locals.user)) {
			return fail(403, { retire: { error: 'Retiring a bucket requires manufacturing:admin' } });
		}
		await connectDB();
		const d = await request.formData();
		try {
			await retireBucket(params.bucketId, String(d.get('reason') ?? ''), { _id: locals.user._id, username: locals.user.username });
			return { retire: { success: true } };
		} catch (e) {
			if (e instanceof BucketError) return fail(e.status, { retire: { error: e.message } });
			throw e;
		}
	}
};
