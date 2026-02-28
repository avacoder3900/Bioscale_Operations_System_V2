import { json, error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { connectDB, AgentMessage, RoutingPattern } from '$lib/server/db';
import type { RequestHandler } from './$types';

function requireApiKey(request: Request) {
	const key = request.headers.get('x-api-key') || request.headers.get('x-agent-api-key') || request.headers.get('authorization')?.replace('Bearer ', '');
	if (!env.AGENT_API_KEY || key !== env.AGENT_API_KEY) {
		throw error(401, 'Invalid or missing API key');
	}
}

export const GET: RequestHandler = async ({ request, url }) => {
	requireApiKey(request);
	await connectDB();

	const page = parseInt(url.searchParams.get('page') || '1');
	const limit = parseInt(url.searchParams.get('limit') || '50');
	const status = url.searchParams.get('status') || null;
	const userId = url.searchParams.get('userId') || null;

	if (!userId) {
		return json({ success: false, error: 'userId parameter is required' }, { status: 400 });
	}

	const filter: any = {};
	if (status) filter.status = status;
	filter.$or = [{ fromUserId: userId }, { toUserId: userId }];

	const [messages, total] = await Promise.all([
		AgentMessage.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
		AgentMessage.countDocuments(filter)
	]);

	return json({
		success: true,
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
	});
};

export const POST: RequestHandler = async ({ request }) => {
	requireApiKey(request);
	await connectDB();

	const body = await request.json();
	const { toUserId, messageType, subject, content, priority, relatedEntityType, relatedEntityId } = body;

	if (!toUserId || !content) throw error(400, 'toUserId and content required');

	// Try to find a routing pattern match
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
			// Increment usage
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

	return json({ id: message._id, status: 'pending' }, { status: 201 });
};

export const PATCH: RequestHandler = async ({ request }) => {
	requireApiKey(request);
	await connectDB();

	const body = await request.json();
	const { messageId, status } = body;

	if (!messageId || !status) throw error(400, 'messageId and status required');

	const update: any = { status };
	if (status === 'sent') update.sentAt = new Date();
	else if (status === 'delivered') update.deliveredAt = new Date();
	else if (status === 'read') update.readAt = new Date();
	else if (status === 'actioned') update.actionedAt = new Date();

	const msg = await AgentMessage.findByIdAndUpdate(messageId, update, { new: true }).lean() as any;
	if (!msg) throw error(404, 'Message not found');

	return json({ id: msg._id, status: msg.status });
};
