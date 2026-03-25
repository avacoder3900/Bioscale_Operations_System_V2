import { json, error } from '@sveltejs/kit';
import { connectDB, WorkflowViolation, AuditLog } from '$lib/server/db';
import { generateId } from '$lib/server/db/utils.js';
import { requireAgentApiKey } from '$lib/server/api-auth';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ request, url }) => {
	requireAgentApiKey(request);
	await connectDB();

	const resolved = url.searchParams.get('resolved');
	const type = url.searchParams.get('type');
	const taskId = url.searchParams.get('taskId');
	const page = parseInt(url.searchParams.get('page') || '1');
	const limit = parseInt(url.searchParams.get('limit') || '50');

	const filter: any = {};
	if (resolved !== null) filter.resolved = resolved === 'true';
	if (type) filter.type = type;
	if (taskId) filter.taskId = taskId;

	const [violations, total] = await Promise.all([
		WorkflowViolation.find(filter).sort({ timestamp: -1 }).skip((page - 1) * limit).limit(limit).lean(),
		WorkflowViolation.countDocuments(filter)
	]);

	return json({
		success: true,
		data: {
			violations: violations.map((v: any) => ({
				id: v._id,
				type: v.type,
				taskId: v.taskId,
				assignee: v.assignee,
				description: v.description,
				severity: v.severity,
				resolved: v.resolved,
				resolvedAt: v.resolvedAt,
				resolvedBy: v.resolvedBy,
				timestamp: v.timestamp
			})),
			pagination: { page, limit, total, hasNext: page * limit < total }
		}
	});
};

export const POST: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await connectDB();

	const body = await request.json();
	const { type, taskId, assignee, description, severity } = body;

	if (!type) throw error(400, 'type is required');
	if (!taskId) throw error(400, 'taskId is required');
	if (!description) throw error(400, 'description is required');

	const now = new Date();
	const violationId = generateId();

	const violation = await WorkflowViolation.create({
		_id: violationId,
		type,
		taskId,
		assignee: assignee || undefined,
		description,
		severity: severity || 'medium',
		timestamp: now
	});

	await AuditLog.create({
		_id: generateId(),
		tableName: 'workflow_violations',
		recordId: violationId,
		action: 'INSERT',
		newData: { type, taskId, description, severity: severity || 'medium' },
		changedBy: 'agent',
		changedAt: now
	});

	return json({
		success: true,
		data: {
			id: violation._id,
			type: violation.type,
			taskId: violation.taskId,
			description: violation.description,
			severity: violation.severity,
			timestamp: violation.timestamp
		}
	}, { status: 201 });
};
