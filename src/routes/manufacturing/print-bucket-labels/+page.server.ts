/**
 * Bucket labels (BUCKET-SYSTEM_PLAN.md §9.4).
 *
 * A bucket's identity is its BKT-NNNNNN id, permanently. Its physical label
 * is either of two things, the operator's choice:
 *   - a QR sticker from the already-printed Avery cartridge sheets, assigned
 *     to the bucket by scanning it (`ProductionBucket.barcode`); or
 *   - a printed BKT- label rendered here.
 * Both scan to the same bucket everywhere. A scuffed sticker is replaced by
 * assigning a new one; the BKT id and all history stay put.
 *
 * Actions:
 *   mint     — new tubs; each id becomes an `available` bucket immediately.
 *   assignQr — put a sticker on a bucket (or replace it). Called via fetch so
 *              the page can work through a queue of freshly minted ids.
 *   reprint  — render an existing BKT- id again. Never mints.
 */
import { fail } from '@sveltejs/kit';
import { connectDB, ProductionBucket } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import { BucketError, mintBuckets, assignBucketBarcode, normalizeBucketId } from '$lib/server/services/bucket-service';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();
	const [recent, unassigned] = await Promise.all([
		ProductionBucket.find({})
			.select('_id barcode state cycleCount homeLocation createdAt createdBy')
			.sort({ createdAt: -1 })
			.limit(25)
			.lean() as any as Promise<any[]>,
		ProductionBucket.find({ state: { $ne: 'retired' }, $or: [{ barcode: { $exists: false } }, { barcode: null }, { barcode: '' }] })
			.select('_id state createdAt')
			.sort({ createdAt: -1 })
			.limit(100)
			.lean() as any as Promise<any[]>
	]);
	return {
		// Deep link from the board / detail page: preselect this bucket for assignment.
		presetBucket: url.searchParams.get('bucket')?.trim() || null,
		recent: recent.map(b => ({
			bucketId: b._id,
			barcode: b.barcode ?? null,
			state: b.state,
			cycleCount: b.cycleCount ?? 0,
			homeLocation: b.homeLocation ?? null,
			createdAt: b.createdAt ? new Date(b.createdAt).toISOString() : null,
			createdBy: b.createdBy?.username ?? null
		})),
		unassigned: unassigned.map(b => ({ bucketId: b._id, state: b.state }))
	};
};

export const actions: Actions = {
	mint: async ({ request, locals }) => {
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();
		const data = await request.formData();
		const count = Number(data.get('count') ?? 1);
		const homeLocation = (data.get('homeLocation') as string | null)?.trim() || undefined;
		const mode = data.get('mode') === 'print' ? 'print' : 'assign';
		try {
			const ids = await mintBuckets(count, { _id: locals.user!._id, username: locals.user!.username }, homeLocation);
			return { labels: { success: true, mode, ids } };
		} catch (e) {
			if (e instanceof BucketError) return fail(e.status, { labels: { error: e.message } });
			throw e;
		}
	},

	assignQr: async ({ request, locals }) => {
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();
		const data = await request.formData();
		try {
			const r = await assignBucketBarcode({
				bucketId: String(data.get('bucketId') ?? ''),
				barcode: String(data.get('barcode') ?? ''),
				user: { _id: locals.user!._id, username: locals.user!.username }
			});
			return { assign: { success: true, ...r } };
		} catch (e) {
			if (e instanceof BucketError) return fail(e.status, { assign: { error: e.message, code: e.code ?? null } });
			throw e;
		}
	},

	reprint: async ({ request, locals }) => {
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();
		const data = await request.formData();
		const raw = (data.get('bucketIds') as string | null) ?? '';
		const ids = Array.from(new Set(raw.split(/[\s,]+/).map(normalizeBucketId).filter(Boolean)));
		if (ids.length === 0) return fail(400, { labels: { error: 'Enter or scan at least one bucket id' } });
		const existing = await ProductionBucket.find({ _id: { $in: ids } }).select('_id state').lean() as any[];
		const known = new Set(existing.map(b => b._id));
		const missing = ids.filter(id => !known.has(id));
		if (missing.length) return fail(404, { labels: { error: `Not a known bucket: ${missing.join(', ')}` } });
		const retired = existing.filter(b => b.state === 'retired').map(b => b._id);
		if (retired.length) return fail(400, { labels: { error: `Retired buckets cannot be reprinted: ${retired.join(', ')}` } });
		return { labels: { success: true, mode: 'print', ids } };
	}
};
