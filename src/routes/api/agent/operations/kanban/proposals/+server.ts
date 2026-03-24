import { json, error } from '@sveltejs/kit';
import { connectDB, KanbanTask, AuditLog } from '$lib/server/db';
import { generateId } from '$lib/server/db/utils.js';
import { requireAgentApiKey } from '$lib/server/api-auth';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
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
