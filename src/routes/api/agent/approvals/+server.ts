import { json, error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { connectDB, ApprovalRequest } from '$lib/server/db';
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

	const status = url.searchParams.get('status') || null;
	const page = parseInt(url.searchParams.get('page') || '1');
	const limit = 50;

	const filter: any = {};
	if (status) filter.status = status;

	const [approvals, total] = await Promise.all([
		ApprovalRequest.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
		ApprovalRequest.countDocuments(filter)
	]);

	return json({
		approvals: approvals.map((a: any) => ({
			id: a._id,
			requesterId: a.requesterId,
			changeTitle: a.changeTitle,
			changeDescription: a.changeDescription,
			changeType: a.changeType,
			priority: a.priority,
			status: a.status,
			affectedSystems: a.affectedSystems,
			impactAnalysis: a.impactAnalysis,
			dueDate: a.dueDate,
			approvedAt: a.approvedAt,
			approvedBy: a.approvedBy,
			historyCount: a.history?.length ?? 0,
			createdAt: a.createdAt
		})),
		pagination: { page, limit, total, hasNext: page * limit < total }
	});
};

export const POST: RequestHandler = async ({ request }) => {
	requireApiKey(request);
	await connectDB();

	const body = await request.json();
	const { requesterId, changeTitle, changeDescription, changeType, priority, affectedSystems, impactAnalysis, dueDate } = body;

	if (!changeTitle || !changeType) throw error(400, 'changeTitle and changeType required');

	const approval = await ApprovalRequest.create({
		requesterId: requesterId || 'agent',
		changeTitle,
		changeDescription: changeDescription || undefined,
		changeType,
		priority: priority || 'normal',
		affectedSystems: affectedSystems || [],
		impactAnalysis: impactAnalysis || {},
		status: 'pending',
		dueDate: dueDate ? new Date(dueDate) : undefined,
		history: [{
			stakeholderId: requesterId || 'agent',
			action: 'requested',
			comments: changeDescription || 'Approval requested',
			timestamp: new Date()
		}]
	});

	return json({ id: approval._id, status: 'pending' }, { status: 201 });
};

export const PATCH: RequestHandler = async ({ request }) => {
	requireApiKey(request);
	await connectDB();

	const body = await request.json();
	const { approvalId, action, stakeholderId, comments, decisionRationale } = body;

	if (!approvalId || !action) throw error(400, 'approvalId and action required');

	const update: any = {
		$push: {
			history: {
				stakeholderId: stakeholderId || 'agent',
				action,
				comments: comments || undefined,
				decisionRationale: decisionRationale || undefined,
				timestamp: new Date()
			}
		}
	};

	if (action === 'approved') {
		update.$set = { status: 'approved', approvedAt: new Date(), approvedBy: stakeholderId || 'agent' };
	} else if (action === 'rejected') {
		update.$set = { status: 'rejected' };
	} else if (action === 'reviewed') {
		update.$set = { status: 'in_review' };
	} else if (action === 'cancelled') {
		update.$set = { status: 'cancelled' };
	}

	const doc = await ApprovalRequest.findByIdAndUpdate(approvalId, update, { new: true }).lean() as any;
	if (!doc) throw error(404, 'Approval not found');

	return json({ id: doc._id, status: doc.status });
};
