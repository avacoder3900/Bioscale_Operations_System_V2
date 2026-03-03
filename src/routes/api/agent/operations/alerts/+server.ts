import { json } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import {
	connectDB, PartDefinition, Equipment, KanbanTask,
	ApprovalRequest, AgentMessage
} from '$lib/server/db';
import type { RequestHandler } from './$types';

interface Alert {
	type: string;
	severity: 'info' | 'warning' | 'critical';
	message: string;
	entityId: string;
	entityType: string;
	createdAt: string;
}

export const GET: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await connectDB();

	const now = new Date();
	const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

	const [lowStockParts, problemEquipment, overdueTasks, staleApprovals, failedMessages] = await Promise.all([
		PartDefinition.find({ isActive: true, inventoryCount: { $lte: 0 } })
			.select('_id partNumber name inventoryCount').lean(),
		Equipment.find({ status: { $ne: 'active' } })
			.select('_id name equipmentType status').lean(),
		KanbanTask.find({
			dueDate: { $lt: now },
			status: { $nin: ['done'] },
			archived: { $ne: true }
		}).select('_id title dueDate status').lean(),
		ApprovalRequest.find({
			status: 'pending',
			createdAt: { $lt: oneDayAgo }
		}).select('_id changeTitle createdAt').lean(),
		AgentMessage.find({ status: 'failed' })
			.select('_id toUserId subject createdAt').lean()
	]);

	const alerts: Alert[] = [];

	for (const p of lowStockParts as any[]) {
		alerts.push({
			type: 'low_stock',
			severity: 'warning',
			message: `Part ${p.partNumber || p.name} has ${p.inventoryCount ?? 0} stock`,
			entityId: p._id,
			entityType: 'part_definition',
			createdAt: now.toISOString()
		});
	}

	for (const e of problemEquipment as any[]) {
		alerts.push({
			type: 'equipment_issue',
			severity: e.status === 'offline' ? 'critical' : 'warning',
			message: `${e.name} (${e.equipmentType}) is ${e.status}`,
			entityId: e._id,
			entityType: 'equipment',
			createdAt: now.toISOString()
		});
	}

	for (const t of overdueTasks as any[]) {
		alerts.push({
			type: 'overdue_task',
			severity: 'warning',
			message: `Task "${t.title}" is overdue (due ${t.dueDate?.toISOString()?.split('T')[0]})`,
			entityId: t._id,
			entityType: 'kanban_task',
			createdAt: now.toISOString()
		});
	}

	for (const a of staleApprovals as any[]) {
		alerts.push({
			type: 'pending_approval',
			severity: 'info',
			message: `Approval "${a.changeTitle}" pending for >24h`,
			entityId: a._id,
			entityType: 'approval_request',
			createdAt: a.createdAt?.toISOString() || now.toISOString()
		});
	}

	for (const m of failedMessages as any[]) {
		alerts.push({
			type: 'failed_message',
			severity: 'warning',
			message: `Message to ${m.toUserId} failed: ${m.subject || '(no subject)'}`,
			entityId: m._id,
			entityType: 'agent_message',
			createdAt: m.createdAt?.toISOString() || now.toISOString()
		});
	}

	// Sort by severity: critical > warning > info
	const severityOrder = { critical: 0, warning: 1, info: 2 };
	alerts.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

	const bySeverity = { info: 0, warning: 0, critical: 0 };
	for (const a of alerts) bySeverity[a.severity]++;

	return json({
		success: true,
		data: {
			alerts,
			summary: { total: alerts.length, bySeverity }
		}
	});
};
