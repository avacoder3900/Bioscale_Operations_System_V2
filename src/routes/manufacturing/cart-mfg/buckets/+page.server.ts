/**
 * Bucket board — stage columns + scan rail (BUCKET-SYSTEM_PLAN.md §9.1).
 * Every mutation goes through bucket-service; this file only parses forms,
 * enforces permissions and maps BucketError → fail().
 */
import { fail, redirect } from '@sveltejs/kit';
import { connectDB, ReceivingLot, InventoryTransaction } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import {
	BucketError, BUCKET_STAGES, STAGE_LABELS, CARTRIDGE_BLANK_PART, BARCODE_LABEL_PART,
	boardData, stageCounts, resolveScan, isBucketStage,
	startCycle, advanceCycle, adjustCycle, scrapFromCycle, reportResidual, retireBucket
} from '$lib/server/services/bucket-service';
import type { Actions, PageServerLoad } from './$types';

export const config = { maxDuration: 60 };

type Op = { _id: string; username: string };
function op(locals: App.Locals): Op {
	return { _id: locals.user!._id, username: locals.user!.username };
}

/** Same per-lot remaining math WI-01 uses for its dropdowns. */
async function availableLots(partNumbers: string[]) {
	const lots = await ReceivingLot.find({
		'part.partNumber': { $in: partNumbers },
		status: { $nin: ['rejected', 'returned'] }
	}).select('lotId part.partNumber quantity').lean() as any[];
	const agg = await InventoryTransaction.aggregate([
		{ $match: { lotId: { $in: lots.map(l => l.lotId) }, transactionType: { $in: ['consumption', 'scrap'] } } },
		{ $group: { _id: '$lotId', total: { $sum: '$quantity' } } }
	]);
	const consumed = new Map((agg as any[]).map(r => [r._id, Math.abs(r.total ?? 0)]));
	const out: Record<string, { lotId: string; remaining: number }[]> = Object.fromEntries(partNumbers.map(p => [p, []]));
	for (const l of lots) {
		const pn = l.part?.partNumber;
		if (!out[pn]) continue;
		const remaining = Math.max(0, Number(l.quantity ?? 0) - (consumed.get(l.lotId) ?? 0));
		if (remaining > 0) out[pn].push({ lotId: l.lotId, remaining });
	}
	for (const pn of partNumbers) out[pn].sort((a, b) => b.remaining - a.remaining);
	return out;
}

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();

	const focusStage = url.searchParams.get('stage') ?? '';
	const q = url.searchParams.get('q') ?? '';

	const [board, counts, lots, scan] = await Promise.all([
		boardData(),
		stageCounts(),
		availableLots([CARTRIDGE_BLANK_PART, BARCODE_LABEL_PART]),
		q ? resolveScan(q) : Promise.resolve(null)
	]);

	return {
		stages: BUCKET_STAGES.map(s => ({ key: s, label: STAGE_LABELS[s] })),
		focusStage: focusStage === 'available' || isBucketStage(focusStage) ? focusStage : null,
		board,
		counts,
		lots,
		canAdjust: locals.user.roles.some(r => r.permissions.includes('manufacturing:admin') || r.permissions.includes('admin:full')),
		scan: scan ? JSON.parse(JSON.stringify(scan)) : null,
		scanQuery: q
	};
};

function wrap(key: string, fn: () => Promise<Record<string, unknown>>) {
	return async () => {
		try {
			return await fn();
		} catch (e) {
			if (e instanceof BucketError) return fail(e.status, { [key]: { error: e.message, code: e.code ?? null } });
			throw e;
		}
	};
}

export const actions: Actions = {
	start: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();
		const d = await request.formData();
		return wrap('start', async () => {
			const cycle = await startCycle({
				bucketId: String(d.get('bucketId') ?? ''),
				quantity: Number(d.get('quantity') ?? 0),
				sourceLotId: String(d.get('sourceLotId') ?? ''),
				emptyConfirmed: d.get('emptyConfirmed') === '1',
				user: op(locals)
			});
			return { start: { success: true, cycleId: cycle._id, bucketId: cycle.bucketId, cycleNumber: cycle.cycleNumber } };
		})();
	},

	advance: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();
		const d = await request.formData();
		return wrap('advance', async () => {
			const cycle = await advanceCycle({
				cycleId: String(d.get('cycleId') ?? ''),
				barcodeLotId: (d.get('barcodeLotId') as string | null) ?? undefined,
				user: op(locals)
			});
			return { advance: { success: true, cycleId: cycle._id, stage: cycle.stage } };
		})();
	},

	adjust: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		// Count corrections change numbers without physical justification —
		// the one action on this page held above plain write.
		if (!locals.user.roles.some(r => r.permissions.includes('manufacturing:admin') || r.permissions.includes('admin:full'))) {
			return fail(403, { adjust: { error: 'Count corrections require manufacturing:admin' } });
		}
		await connectDB();
		const d = await request.formData();
		return wrap('adjust', async () => {
			const cycle = await adjustCycle({
				cycleId: String(d.get('cycleId') ?? ''),
				newQuantity: Number(d.get('newQuantity') ?? 0),
				reason: String(d.get('reason') ?? ''),
				user: op(locals)
			});
			return { adjust: { success: true, cycleId: cycle._id, quantity: cycle.quantity } };
		})();
	},

	scrap: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();
		const d = await request.formData();
		return wrap('scrap', async () => {
			const { cycle, removalId } = await scrapFromCycle({
				cycleId: String(d.get('cycleId') ?? ''),
				quantity: Number(d.get('quantity') ?? 0),
				journal: String(d.get('journal') ?? ''),
				user: op(locals)
			});
			return { scrap: { success: true, cycleId: cycle?._id ?? null, quantity: cycle?.quantity ?? 0, status: cycle?.status ?? null, removalId } };
		})();
	},

	residual: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();
		const d = await request.formData();
		return wrap('residual', async () => {
			const stage = String(d.get('stage') ?? '');
			if (!isBucketStage(stage)) throw new BucketError('Pick the stage the leftover cartridges are at.');
			const disposition = String(d.get('disposition') ?? '');
			if (disposition !== 'merge' && disposition !== 'scrap' && disposition !== 'defer') throw new BucketError('Choose a disposition.');
			const r = await reportResidual({
				bucketId: String(d.get('bucketId') ?? ''),
				quantity: Number(d.get('quantity') ?? 0),
				stage,
				disposition,
				destinationBucketId: (d.get('destinationBucketId') as string | null) ?? undefined,
				journal: (d.get('journal') as string | null) ?? undefined,
				user: op(locals)
			});
			return { residual: { success: true, bucketId: r.bucket?._id ?? null, state: r.bucket?.state ?? null, disposition } };
		})();
	},

	retire: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		if (!locals.user.roles.some(r => r.permissions.includes('manufacturing:admin') || r.permissions.includes('admin:full'))) {
			return fail(403, { retire: { error: 'Retiring a bucket requires manufacturing:admin' } });
		}
		await connectDB();
		const d = await request.formData();
		return wrap('retire', async () => {
			await retireBucket(String(d.get('bucketId') ?? ''), String(d.get('reason') ?? ''), op(locals));
			return { retire: { success: true } };
		})();
	}
};
