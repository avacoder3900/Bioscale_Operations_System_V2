/**
 * New bucket (BUCKET-SYSTEM_PLAN.md v2 §9.4): one bucket at a time, one QR
 * sticker scanned, nothing else asked. The bucket gets a permanent internal
 * BKT- id behind the sticker so a damaged sticker can be replaced later
 * without the tub becoming a new bucket. No label printing, no location.
 */
import { fail, redirect } from '@sveltejs/kit';
import { connectDB, ProductionBucket } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import { BucketError, createBucket, replaceBucketSticker } from '$lib/server/services/bucket-service';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();
	const recent = await ProductionBucket.find({})
		.select('_id barcode state cycleCount createdAt createdBy')
		.sort({ createdAt: -1 })
		.limit(25)
		.lean() as any[];
	return {
		// Deep link from the board / history page: preselect this bucket for a sticker replacement.
		presetBucket: url.searchParams.get('bucket')?.trim() || null,
		recent: recent.map(b => ({
			bucketId: b._id,
			barcode: b.barcode ?? null,
			state: b.state,
			cycleCount: b.cycleCount ?? 0,
			createdAt: b.createdAt ? new Date(b.createdAt).toISOString() : null,
			createdBy: b.createdBy?.username ?? null
		}))
	};
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();
		const d = await request.formData();
		try {
			const r = await createBucket({ qr: String(d.get('qr') ?? ''), user: { _id: locals.user._id, username: locals.user.username } });
			return { create: { success: true, ...r } };
		} catch (e) {
			if (e instanceof BucketError) return fail(e.status, { create: { error: e.message } });
			throw e;
		}
	},

	replace: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();
		const d = await request.formData();
		try {
			const r = await replaceBucketSticker({
				bucketId: String(d.get('bucketId') ?? ''),
				qr: String(d.get('qr') ?? ''),
				user: { _id: locals.user._id, username: locals.user.username }
			});
			return { replace: { success: true, ...r } };
		} catch (e) {
			if (e instanceof BucketError) return fail(e.status, { replace: { error: e.message } });
			throw e;
		}
	}
};
