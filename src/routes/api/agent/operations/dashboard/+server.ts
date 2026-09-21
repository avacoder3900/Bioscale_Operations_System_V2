import { json } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import {
	connectDB, KanbanTask, Equipment, PartDefinition,
	ProductionRun, AuditLog, ApprovalRequest
} from '$lib/server/db';
import { ALL_STATUSES } from '$lib/shared/kanban-status';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await connectDB();

	const [
		taskTotal,
		statusAgg,
		recentTasks,
		eqTotal, eqActive, eqMaintenance, eqOffline,
		lowStockParts, totalParts,
		activeRuns,
		recentActivity,
		pendingApprovals
	] = await Promise.all([
		KanbanTask.countDocuments({ archived: { $ne: true } }),
		KanbanTask.aggregate([
			{ $match: { archived: { $ne: true } } },
			{ $group: { _id: '$status', count: { $sum: 1 } } }
		]),
		KanbanTask.find({ archived: { $ne: true } })
			.sort({ updatedAt: -1 }).limit(5)
			.select('_id title status assignee updatedAt').lean(),
		Equipment.countDocuments(),
		Equipment.countDocuments({ status: 'active' }),
		Equipment.countDocuments({ status: 'maintenance' }),
		Equipment.countDocuments({ status: 'offline' }),
		PartDefinition.countDocuments({ isActive: true, inventoryCount: { $lte: 0 } }),
		PartDefinition.countDocuments({ isActive: true }),
		ProductionRun.countDocuments({ status: 'in_progress' }),
		AuditLog.find().sort({ changedAt: -1 }).limit(10)
			.select('_id tableName action changedAt changedBy').lean(),
		ApprovalRequest.countDocuments({ status: 'pending' })
	]);

	const byStatus: Record<string, number> = {};
	for (const s of ALL_STATUSES) byStatus[s] = 0;
	for (const row of statusAgg as any[]) {
		if (row._id in byStatus) byStatus[row._id] = row.count;
	}

	return json({
		success: true,
		data: {
			tasks: {
				total: taskTotal,
				byStatus,
				recent: (recentTasks as any[]).map(t => ({
					id: t._id, title: t.title, status: t.status,
					assignee: t.assignee, updatedAt: t.updatedAt
				}))
			},
			equipment: {
				total: eqTotal,
				byStatus: { active: eqActive, maintenance: eqMaintenance, offline: eqOffline }
			},
			inventory: { lowStockCount: lowStockParts, totalParts },
			production: { activeRuns },
			recentActivity: (recentActivity as any[]).map(a => ({
				id: a._id, tableName: a.tableName, action: a.action,
				changedAt: a.changedAt, changedBy: a.changedBy
			})),
			pendingApprovals
		}
	});
};
