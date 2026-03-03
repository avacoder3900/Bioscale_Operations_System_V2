import { json, error } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB, AgentMessage, RoutingPattern, AuditLog, generateId } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ request, url }) => {
	requireAgentApiKey(request);
	await connectDB();

	const page = parseInt(url.searchParams.get('page') || '1');
	const limit = parseInt(url.searchParams.get('limit') || '50');
	const status = url.searchParams.get('status') || null;
	const userId = url.searchParams.get('userId') || null;

	if (!userId) {
		return json({ success: false, error: 'userId parameter is required' }, { status: 400 });
	}

	const filter: Record<string, unknown> = {};
	if (status) filter.status = status;
	filter.$or = [{ fromUserId: userId }, { toUserId: userId }];

	const [messages, total] = await Promise.all([
		AgentMessage.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
		AgentMessage.countDocuments(filter)
	]);

	return json({
		success: true,
		data: {
			messages: messages.map((m: any) => ({
				id: m._id,
				fromUserId: m.fromUserId,
				toUserId: m.toUserId,
				messageType: m.messageType,
				subject: m.subject,
				content: m.content,
				priority: m.priority,
				status: m.status,
				relatedEntityType: m.relatedEntityType,
				relatedEntityId: m.relatedEntityId,
				routingReason: m.routingReason,
				sentAt: m.sentAt,
				deliveredAt: m.deliveredAt,
				readAt: m.readAt,
				createdAt: m.createdAt
			})),
			pagination: { page, limit, total, hasNext: page * limit < total }
		}
	});
};

export const POST: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await connectDB();

	const body = await request.json();
	const { toUserId, messageType, subject, content, priority, relatedEntityType, relatedEntityId } = body;

	if (!toUserId || !content) {
		return json({ success: false, error: 'toUserId and content required' }, { status: 400 });
	}

	let routingReason = 'direct';
	let audienceTier = 'individual';
	if (messageType) {
		const pattern = await RoutingPattern.findOne({
			contentType: messageType,
			$expr: { $gt: ['$confidenceScore', 0.5] }
		}).sort({ confidenceScore: -1 }).lean() as any;

		if (pattern) {
			routingReason = `pattern:${pattern._id}`;
			audienceTier = pattern.stakeholderRoles?.[0] ?? 'individual';
			await RoutingPattern.findByIdAndUpdate(pattern._id, {
				$inc: { usageCount: 1 },
				lastUsed: new Date()
			});
		}
	}

	const message = await AgentMessage.create({
		fromUserId: 'agent',
		toUserId,
		messageType: messageType || 'info',
		subject: subject || undefined,
		content,
		priority: priority || 'normal',
		status: 'pending',
		relatedEntityType: relatedEntityType || undefined,
		relatedEntityId: relatedEntityId || undefined,
		routingReason,
		audienceTier
	});

	await AuditLog.create({
		_id: generateId(),
		tableName: 'agent_messages',
		recordId: message._id,
		action: 'INSERT',
		newData: { toUserId, messageType: messageType || 'info', priority: priority || 'normal' },
		changedAt: new Date(),
		changedBy: 'agent-api'
	});

	return json({ success: true, data: { id: message._id, status: 'pending' } }, { status: 201 });
};

export const PATCH: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await connectDB();

	const body = await request.json();
	const { messageId, status } = body;

	if (!messageId || !status) {
		return json({ success: false, error: 'messageId and status required' }, { status: 400 });
	}

	const existing = await AgentMessage.findById(messageId).lean() as any;
	if (!existing) throw error(404, 'Message not found');

	const update: Record<string, unknown> = { status };
	if (status === 'sent') update.sentAt = new Date();
	else if (status === 'delivered') update.deliveredAt = new Date();
	else if (status === 'read') update.readAt = new Date();
	else if (status === 'actioned') update.actionedAt = new Date();

	const msg = await AgentMessage.findByIdAndUpdate(messageId, update, { new: true }).lean() as any;

	await AuditLog.create({
		_id: generateId(),
		tableName: 'agent_messages',
		recordId: messageId,
		action: 'UPDATE',
		oldData: { status: existing.status },
		newData: { status: msg.status },
		changedAt: new Date(),
		changedBy: 'agent-api'
	});

	return json({ success: true, data: { id: msg._id, status: msg.status } });
};
