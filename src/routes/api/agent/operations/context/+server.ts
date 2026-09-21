import { json } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import {
	connectDB, KanbanTask, Equipment,
	ApprovalRequest, AgentMessage
} from '$lib/server/db';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await connectDB();

	const [wipTasks, equipmentAlerts, pendingApprovals, pendingMessages] = await Promise.all([
		KanbanTask.find({ status: 'wip', archived: { $ne: true } })
			.select('_id title assignee tags dueDate sizeClass statusChangedAt').sort({ statusChangedAt: -1 }).limit(20).lean(),
		Equipment.find({ status: { $ne: 'active' } })
			.select('_id name equipmentType status location currentTemperatureC lastTemperatureReadAt').lean(),
		ApprovalRequest.find({ status: 'pending' })
			.select('_id changeTitle changeType priority requesterId dueDate createdAt').sort({ createdAt: -1 }).limit(10).lean(),
		AgentMessage.find({ status: 'pending' })
			.select('_id toUserId messageType subject priority createdAt').sort({ createdAt: -1 }).limit(10).lean()
	]);

	return json({
		success: true,
		data: {
			workInProgress: (wipTasks as any[]).map(t => ({
				id: t._id, title: t.title, assignee: t.assignee, tags: t.tags ?? [],
				dueDate: t.dueDate, sizeClass: t.sizeClass ?? null, statusChangedAt: t.statusChangedAt
			})),
			equipmentAlerts: (equipmentAlerts as any[]).map(e => ({
				id: e._id, name: e.name, type: e.equipmentType, status: e.status,
				location: e.location, temperatureC: e.currentTemperatureC, lastReadAt: e.lastTemperatureReadAt
			})),
			pendingApprovals: (pendingApprovals as any[]).map(a => ({
				id: a._id, title: a.changeTitle, type: a.changeType,
				priority: a.priority, requesterId: a.requesterId, dueDate: a.dueDate, createdAt: a.createdAt
			})),
			pendingMessages: (pendingMessages as any[]).map(m => ({
				id: m._id, toUserId: m.toUserId, type: m.messageType,
				subject: m.subject, priority: m.priority, createdAt: m.createdAt
			}))
		}
	});
};
