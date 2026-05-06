import { redirect } from '@sveltejs/kit';
import { connectDB, AskBimsCostLog } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import { DAILY_CAPS, WORKSPACE_DAILY_CAP_USD, ALLOWED_MODELS } from '$lib/server/ask-bims';
import type { PageServerLoad } from './$types';

function startOfTodayUtc(): Date {
	const d = new Date();
	d.setUTCHours(0, 0, 0, 0);
	return d;
}

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'admin:full');
	await connectDB();

	const now = new Date();
	const startToday = startOfTodayUtc();
	const start7d = new Date(now.getTime() - 7 * 86400e3);
	const start30d = new Date(now.getTime() - 30 * 86400e3);

	const [
		todayByModel,
		todayByUser,
		last7dDaily,
		last7dByUser,
		last30dTotals,
		modelMix7d
	] = await Promise.all([
		// Today: cost grouped by model
		AskBimsCostLog.aggregate([
			{ $match: { timestamp: { $gte: startToday } } },
			{ $group: { _id: '$model', costUsd: { $sum: '$costUsd' }, queries: { $sum: 1 } } }
		]),
		// Today: cost grouped by user
		AskBimsCostLog.aggregate([
			{ $match: { timestamp: { $gte: startToday } } },
			{ $group: {
				_id: '$userId',
				username: { $first: '$username' },
				costUsd: { $sum: '$costUsd' },
				queries: { $sum: 1 }
			} },
			{ $sort: { costUsd: -1 } }
		]),
		// Last 7 days, daily totals (for the trend chart)
		AskBimsCostLog.aggregate([
			{ $match: { timestamp: { $gte: start7d } } },
			{ $group: {
				_id: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } },
				costUsd: { $sum: '$costUsd' },
				queries: { $sum: 1 }
			} },
			{ $sort: { _id: 1 } }
		]),
		// Last 7 days, top users
		AskBimsCostLog.aggregate([
			{ $match: { timestamp: { $gte: start7d } } },
			{ $group: {
				_id: '$userId',
				username: { $first: '$username' },
				costUsd: { $sum: '$costUsd' },
				queries: { $sum: 1 }
			} },
			{ $sort: { costUsd: -1 } },
			{ $limit: 10 }
		]),
		// Last 30 days totals
		AskBimsCostLog.aggregate([
			{ $match: { timestamp: { $gte: start30d } } },
			{ $group: { _id: null, costUsd: { $sum: '$costUsd' }, queries: { $sum: 1 } } }
		]),
		// Last 7 days by model
		AskBimsCostLog.aggregate([
			{ $match: { timestamp: { $gte: start7d } } },
			{ $group: { _id: '$model', costUsd: { $sum: '$costUsd' }, queries: { $sum: 1 } } }
		])
	]);

	const todayTotal = todayByModel.reduce((s: number, r: any) => s + r.costUsd, 0);
	const last7dTotal = last7dDaily.reduce((s: number, r: any) => s + r.costUsd, 0);
	const last30dTotal = (last30dTotals[0] as any)?.costUsd ?? 0;
	const last30dQueries = (last30dTotals[0] as any)?.queries ?? 0;

	// Project monthly = (last 7 days × 30/7)
	const projectedMonthly = (last7dTotal / 7) * 30;

	// Daily-cap progress per model
	const todayByModelMap = new Map(todayByModel.map((r: any) => [r._id, r.costUsd]));
	const capProgress = ALLOWED_MODELS.map(m => ({
		model: m,
		spent: todayByModelMap.get(m) ?? 0,
		cap: DAILY_CAPS[m],
		pct: Math.round(((todayByModelMap.get(m) ?? 0) / DAILY_CAPS[m]) * 100)
	}));
	const workspacePct = Math.round((todayTotal / WORKSPACE_DAILY_CAP_USD) * 100);

	return {
		now: now.toISOString(),
		today: {
			totalUsd: todayTotal,
			byModel: todayByModel.map((r: any) => ({ model: r._id, costUsd: r.costUsd, queries: r.queries })),
			byUser: todayByUser.map((r: any) => ({
				userId: r._id, username: r.username ?? r._id,
				costUsd: r.costUsd, queries: r.queries
			}))
		},
		last7d: {
			totalUsd: last7dTotal,
			daily: last7dDaily.map((r: any) => ({ date: r._id, costUsd: r.costUsd, queries: r.queries })),
			topUsers: last7dByUser.map((r: any) => ({
				userId: r._id, username: r.username ?? r._id,
				costUsd: r.costUsd, queries: r.queries
			})),
			byModel: modelMix7d.map((r: any) => ({ model: r._id, costUsd: r.costUsd, queries: r.queries }))
		},
		last30d: {
			totalUsd: last30dTotal,
			queries: last30dQueries
		},
		projectedMonthlyUsd: projectedMonthly,
		caps: {
			workspaceUsd: WORKSPACE_DAILY_CAP_USD,
			workspaceSpentToday: todayTotal,
			workspacePct,
			perModel: capProgress
		}
	};
};

export const config = { maxDuration: 30 };
