/**
 * Bucket label printing (BUCKET-SYSTEM_PLAN.md §9.4).
 *
 * Two modes:
 *   mint    — new tubs enter service; each id becomes an `available`
 *             ProductionBucket immediately.
 *   reprint — a scuffed label reprints THE SAME number. The barcode is a
 *             permanent container id, so reprinting never mints.
 *
 * BKT-NNNNNN is sequential and deliberately unlike the UUIDv4 cartridge
 * barcodes: scanning a bucket into a cartridge field fails loudly instead
 * of creating a phantom cartridge.
 */
import { fail } from '@sveltejs/kit';
import { connectDB, ProductionBucket } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import { BucketError, mintBuckets, normalizeBucketId } from '$lib/server/services/bucket-service';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();
	const recent = await ProductionBucket.find({})
		.select('_id state cycleCount homeLocation createdAt createdBy')
		.sort({ createdAt: -1 })
		.limit(25)
		.lean() as any[];
	return {
		recent: recent.map(b => ({
			bucketId: b._id,
			state: b.state,
			cycleCount: b.cycleCount ?? 0,
			homeLocation: b.homeLocation ?? null,
			createdAt: b.createdAt ? new Date(b.createdAt).toISOString() : null,
			createdBy: b.createdBy?.username ?? null
		}))
	};
};

export const actions: Actions = {
	mint: async ({ request, locals }) => {
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();
		const data = await request.formData();
		const count = Number(data.get('count') ?? 1);
		const homeLocation = (data.get('homeLocation') as string | null)?.trim() || undefined;
		try {
			const ids = await mintBuckets(count, { _id: locals.user!._id, username: locals.user!.username }, homeLocation);
			return { labels: { success: true, mode: 'mint', ids } };
		} catch (e) {
			if (e instanceof BucketError) return fail(e.status, { labels: { error: e.message } });
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
		return { labels: { success: true, mode: 'reprint', ids } };
	}
};
