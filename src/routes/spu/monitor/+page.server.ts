/**
 * Fleet view of device monitor mode: every SPU with monitoring.enabled, its
 * flag sync state, the latest daily review verdict and the open findings.
 * "Review all now" runs the same job the 07:30 UTC cron runs.
 */
import { fail } from '@sveltejs/kit';
import { connectDB, Spu, DeviceFinding } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import { runDailyReview } from '$lib/server/device-monitor-review';
import type { Actions, PageServerLoad } from './$types';

export const config = { maxDuration: 300 };

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	const spus = (await Spu.find({ 'monitoring.enabled': true })
		.select('udi status particleLink monitoring')
		.sort({ 'monitoring.enabledAt': -1 })
		.lean()) as any[];

	const deviceIds = spus.map((s) => s.particleLink?.particleDeviceId).filter(Boolean);
	const [latestReviews, openCounts, recentFindings] = await Promise.all([
		DeviceFinding.aggregate([
			{ $match: { deviceId: { $in: deviceIds }, kind: 'daily_review' } },
			{ $sort: { dayKey: -1 } },
			{ $group: { _id: '$deviceId', dayKey: { $first: '$dayKey' }, status: { $first: '$status' }, summary: { $first: '$summary' }, costUsd: { $first: '$costUsd' }, inputCounts: { $first: '$inputCounts' } } }
		]),
		DeviceFinding.aggregate([
			{ $match: { deviceId: { $in: deviceIds }, kind: 'review_finding', resolvedAt: null } },
			{ $group: { _id: '$deviceId', open: { $sum: 1 }, errors: { $sum: { $cond: [{ $eq: ['$severity', 'error'] }, 1, 0] } } } }
		]),
		DeviceFinding.find({ deviceId: { $in: deviceIds }, kind: 'review_finding', resolvedAt: null })
			.sort({ createdAt: -1 })
			.limit(50)
			.lean() as any
	]);
	const reviewBy = new Map(latestReviews.map((r: any) => [r._id, r]));
	const openBy = new Map(openCounts.map((r: any) => [r._id, r]));

	return {
		units: spus.map((s) => {
			const deviceId = s.particleLink?.particleDeviceId ?? null;
			const rv: any = deviceId ? reviewBy.get(deviceId) : null;
			const oc: any = deviceId ? openBy.get(deviceId) : null;
			return {
				id: s._id,
				udi: s.udi,
				status: s.status ?? 'draft',
				deviceId,
				role: s.monitoring?.role ?? 'suspect',
				reason: s.monitoring?.reason ?? '',
				enabledAt: s.monitoring?.enabledAt ?? null,
				enabledBy: s.monitoring?.enabledBy?.username ?? null,
				flagState: s.particleLink?.monitorFlagState ?? null,
				flag: s.particleLink?.monitorFlag ?? null,
				lastReview: rv ? { dayKey: rv.dayKey, status: rv.status, summary: rv.summary, costUsd: rv.costUsd, inputCounts: rv.inputCounts } : null,
				openFindings: oc?.open ?? 0,
				openErrors: oc?.errors ?? 0
			};
		}),
		recentFindings: JSON.parse(JSON.stringify(recentFindings))
	};
};

export const actions: Actions = {
	reviewAll: async ({ locals }) => {
		requirePermission(locals.user, 'spu:write');
		const { results } = await runDailyReview({});
		const failed = results.filter((r) => r.error);
		if (results.length === 0) return fail(400, { error: 'No monitored units with a linked device.' });
		return {
			reviewedAll: true,
			reviewed: results.length,
			failed: failed.length,
			totalCostUsd: Number(results.reduce((a, r) => a + (r.costUsd ?? 0), 0).toFixed(4)),
			message: `Reviewed ${results.length} unit(s)${failed.length ? `, ${failed.length} failed: ${failed.map((f) => `${f.udi}: ${f.error}`).join('; ')}` : ''}`
		};
	}
};
