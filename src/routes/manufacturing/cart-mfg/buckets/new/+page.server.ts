/**
 * New bucket (BUCKET-SYSTEM_PLAN.md v2 §9.4): one bucket at a time, one QR
 * sticker scanned, nothing else asked. The bucket gets a permanent internal
 * BKT- id behind the sticker so a damaged sticker can be replaced later
 * without the tub becoming a new bucket. No label printing, no location.
 */
import { fail, redirect } from '@sveltejs/kit';
import { connectDB, ProductionBucket } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import { BucketError, createBucket, replaceBucketSticker, setBucketNickname } from '$lib/server/services/bucket-service';
import { badgeMode } from '$lib/server/services/badge-service';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();
	// Minting and replacing a sticker are badge-gated again (2026-10-05; the page
	// had no badge from 2026-09-30). Naming a bucket still is not.
	const [recent, badge] = await Promise.all([
		ProductionBucket.find({})
			.select('_id barcode nickname state cycleCount createdAt createdBy')
			.sort({ createdAt: -1 })
			.limit(25)
			.lean() as any as Promise<any[]>,
		badgeMode().catch(() => 'required' as const)
	]);
	return {
		badgeMode: badge,
		// Deep link from the board / history page: preselect this bucket for a sticker replacement.
		presetBucket: url.searchParams.get('bucket')?.trim() || null,
		recent: recent.map(b => ({
			bucketId: b._id,
			barcode: b.barcode ?? null,
			nickname: b.nickname ?? null,
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
			// Nickname is no longer taken here (user, 2026-09-30) — it has its own
			// block below (?/nickname) so the mint stays "scan the sticker, nothing else".
			const r = await createBucket({
				qr: String(d.get('qr') ?? ''),
				badge: String(d.get('badge') ?? ''),
				user: { _id: locals.user._id, username: locals.user.username }
			});
			return { create: { success: true, ...r } };
		} catch (e) {
			if (e instanceof BucketError) return fail(e.status, { create: { error: e.message, code: e.code ?? null } });
			throw e;
		}
	},

	// Third block: scan a bucket's QR, give it a nickname (or clear it with an empty name).
	nickname: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();
		const d = await request.formData();
		try {
			const r = await setBucketNickname({
				bucketId: String(d.get('bucketId') ?? ''),
				nickname: String(d.get('nickname') ?? ''),
				user: { _id: locals.user._id, username: locals.user.username }
			});
			return { nickname: { success: true, ...r } };
		} catch (e) {
			if (e instanceof BucketError) return fail(e.status, { nickname: { error: e.message } });
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
				badge: String(d.get('badge') ?? ''),
				user: { _id: locals.user._id, username: locals.user.username }
			});
			return { replace: { success: true, ...r } };
		} catch (e) {
			if (e instanceof BucketError) return fail(e.status, { replace: { error: e.message, code: e.code ?? null } });
			throw e;
		}
	}
};
