import { json, error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { connectDB, KanbanTask, AuditLog } from '$lib/server/db';
import { generateId } from '$lib/server/db/utils.js';
import type { RequestHandler } from './$types';

function requireApiKey(request: Request) {
	const key = request.headers.get('x-api-key') || request.headers.get('x-agent-api-key') || request.headers.get('authorization')?.replace('Bearer ', '');
	if (!env.AGENT_API_KEY || key !== env.AGENT_API_KEY) {
		throw error(401, 'Invalid or missing API key');
	}
}

export const POST: RequestHandler = async ({ request }) => {
	requireApiKey(request);
	await connectDB();

	const body = await request.json();
	const { proposals } = body;

	if (!Array.isArray(proposals) || proposals.length === 0) {
		throw error(400, 'proposals array is required and must not be empty');
	}

	const batchId = generateId();
	const now = new Date();
	const created: any[] = [];

	for (const p of proposals) {
		const { type, targetTaskId, details, suggestedActions } = p;

		if (!type || !['split', 'merge', 'enrich'].includes(type)) {
			throw error(400, 'Each proposal requires type: split, merge, or enrich');
		}
		if (!targetTaskId) throw error(400, 'Each proposal requires targetTaskId');

		const task = await KanbanTask.findById(targetTaskId) as any;
		if (!task) throw error(404, `Task ${targetTaskId} not found`);

		const proposalId = generateId();
		const proposal = {
			_id: proposalId,
			proposedBy: 'agent',
			proposalType: type,
			decision: 'pending',
			batchId,
			createdAt: now,
			details: details || undefined,
			suggestedActions: suggestedActions || []
		};

		await KanbanTask.findByIdAndUpdate(targetTaskId, {
			$push: {
				proposals: proposal,
				activityLog: {
					_id: generateId(),
					action: 'proposal_created',
					details: { proposalId, type, batchId },
					createdAt: now,
					createdBy: 'agent'
				}
			}
		});

		await AuditLog.create({
			_id: generateId(),
			tableName: 'kanban_tasks',
			recordId: targetTaskId,
			action: 'UPDATE',
			newData: { proposal: { id: proposalId, type, batchId } },
			changedBy: 'agent',
			changedAt: now
		});

		created.push({
			proposalId,
			type,
			targetTaskId,
			batchId,
			decision: 'pending'
		});
	}

	return json({
		success: true,
		data: {
			batchId,
			proposals: created
		}
	}, { status: 201 });
};
