import { json, error } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB, ApprovalRequest, AuditLog, generateId } from '$lib/server/db';
import type { RequestHandler } from './$types';

const VALID_ACTIONS = ['requested', 'reviewed', 'approved', 'rejected', 'escalated', 'cancelled', 'commented'] as const;
const TERMINAL_STATUSES = ['approved', 'rejected', 'cancelled', 'expired'] as const;

export const GET: RequestHandler = async ({ request, url }) => {
	requireAgentApiKey(request);
	await connectDB();

	const status = url.searchParams.get('status') || null;
	const page = parseInt(url.searchParams.get('page') || '1');
	const limit = 50;

	const filter: Record<string, unknown> = {};
	if (status) filter.status = status;

	const [approvals, total] = await Promise.all([
		ApprovalRequest.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
		ApprovalRequest.countDocuments(filter)
	]);

	return json({
		success: true,
		data: {
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
		}
	});
};

export const POST: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await connectDB();

	const body = await request.json();
	const { requesterId, changeTitle, changeDescription, changeType, priority, affectedSystems, impactAnalysis, dueDate } = body;

	if (!changeTitle || !changeType) {
		return json({ success: false, error: 'changeTitle and changeType required' }, { status: 400 });
	}

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

	await AuditLog.create({
		_id: generateId(),
		tableName: 'approval_requests',
		recordId: approval._id,
		action: 'INSERT',
		newData: { changeTitle, changeType, priority: priority || 'normal', requesterId: requesterId || 'agent' },
		changedAt: new Date(),
		changedBy: 'agent-api'
	});

	return json({ success: true, data: { id: approval._id, status: 'pending' } }, { status: 201 });
};

export const PATCH: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await connectDB();

	const body = await request.json();
	const { approvalId, action, stakeholderId, comments, decisionRationale } = body;

	if (!approvalId || !action) {
		return json({ success: false, error: 'approvalId and action required' }, { status: 400 });
	}

	if (!VALID_ACTIONS.includes(action)) {
		return json({
			success: false,
			error: `Invalid action. Must be one of: ${VALID_ACTIONS.join(', ')}`
		}, { status: 400 });
	}

	const existing = await ApprovalRequest.findById(approvalId).lean() as any;
	if (!existing) throw error(404, 'Approval not found');

	if (TERMINAL_STATUSES.includes(existing.status) && action !== 'commented') {
		return json({
			success: false,
			error: `Cannot modify approval in terminal state: ${existing.status}`
		}, { status: 400 });
	}

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

	await AuditLog.create({
		_id: generateId(),
		tableName: 'approval_requests',
		recordId: approvalId,
		action: 'UPDATE',
		oldData: { status: existing.status },
		newData: { status: doc.status, action },
		changedAt: new Date(),
		changedBy: 'agent-api'
	});

	return json({ success: true, data: { id: doc._id, status: doc.status } });
};
