import { redirect } from '@sveltejs/kit';
import { connectDB, AuditLog } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url, locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'admin:full');

	await connectDB();

	const page = parseInt(url.searchParams.get('page') || '1');
	const limit = 50;
	const actionFilter = url.searchParams.get('action') || null;
	const dateFrom = url.searchParams.get('dateFrom') || null;
	const dateTo = url.searchParams.get('dateTo') || null;

	const filter: any = {};
	if (actionFilter) filter.action = actionFilter;
	if (dateFrom || dateTo) {
		filter.changedAt = {};
		if (dateFrom) filter.changedAt.$gte = new Date(dateFrom);
		if (dateTo) filter.changedAt.$lte = new Date(dateTo + 'T23:59:59Z');
	}

	const [entries, total] = await Promise.all([
		AuditLog.find(filter).sort({ changedAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
		AuditLog.countDocuments(filter)
	]);

	// Stats for today
	const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
	const todayStats = await AuditLog.aggregate([
		{ $match: { changedAt: { $gte: todayStart } } },
		{ $group: { _id: '$action', count: { $sum: 1 } } },
		{ $sort: { count: -1 } }
	]);

	const totalActionsToday = todayStats.reduce((s, g) => s + g.count, 0);
	const lastEntry = await AuditLog.findOne().sort({ changedAt: -1 }).lean();
	const actionTypes = await AuditLog.distinct('action');

	return {
		auditEntries: entries.map((e) => ({
			id: e._id, tableName: e.tableName, recordId: e.recordId,
			action: e.action, oldData: e.oldData ?? null, newData: e.newData ?? null,
			changedAt: e.changedAt, changedBy: e.changedBy ?? null
		})),
		pagination: { page, limit, total, hasNext: page * limit < total, hasPrev: page > 1 },
		stats: {
			totalActionsToday,
			mostCommonAction: todayStats[0]?._id ?? '',
			mostCommonActionCount: todayStats[0]?.count ?? 0,
			lastActiveTime: lastEntry?.changedAt ?? null
		},
		filters: {
			actionTypes,
			currentAction: actionFilter,
			currentDateFrom: dateFrom,
			currentDateTo: dateTo
		}
	};
};
