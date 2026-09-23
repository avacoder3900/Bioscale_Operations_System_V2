/**
 * Master Override (BUCKET-SYSTEM_PLAN v2 §9.5): scan a bucket, pick ANY phase,
 * it goes there — bypassing thermoseal consumption, the discard prompt and the
 * forward-only order. Admin only; everything it does is labelled MASTER
 * OVERRIDE in the ledger, the cart notes and the audit log.
 */
import { fail, redirect } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import {
	BucketError, boardData, forceBucketPhase, FORCE_TARGETS, FORCE_TARGET_LABELS, STAGE_LABELS, type ForceTarget
} from '$lib/server/services/bucket-service';
import type { Actions, PageServerLoad } from './$types';

function isBucketAdmin(user: App.Locals['user']): boolean {
	return !!user?.roles.some(r => r.permissions.includes('manufacturing:admin') || r.permissions.includes('admin:full'));
}

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();
	const board = await boardData().catch(() => ({ cycles: [] as any[] }));
	return {
		canOverride: isBucketAdmin(locals.user),
		presetBucket: url.searchParams.get('bucket')?.trim() || null,
		targets: FORCE_TARGETS.map(t => ({ key: t, label: FORCE_TARGET_LABELS[t] })),
		stageLabels: STAGE_LABELS as Record<string, string>,
		openPasses: board.cycles.map((c: any) => ({
			cycleId: c.cycleId, bucketId: c.bucketId, barcode: c.barcode ?? null, cycleNumber: c.cycleNumber,
			stage: c.stage, quantity: c.quantity, stageEnteredAt: c.stageEnteredAt ?? null
		}))
	};
};

export const actions: Actions = {
	move: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		if (!isBucketAdmin(locals.user)) return fail(403, { move: { error: 'Master override requires manufacturing:admin' } });
		await connectDB();
		const d = await request.formData();
		try {
			const r = await forceBucketPhase({
				bucket: String(d.get('bucket') ?? ''),
				target: String(d.get('target') ?? '') as ForceTarget,
				reason: String(d.get('reason') ?? ''),
				user: { _id: locals.user._id, username: locals.user.username }
			});
			return { move: { success: true, ...r, fromLabel: STAGE_LABELS[r.from], toLabel: FORCE_TARGET_LABELS[r.to] } };
		} catch (e) {
			if (e instanceof BucketError) return fail(e.status, { move: { error: e.message } });
			throw e;
		}
	}
};
