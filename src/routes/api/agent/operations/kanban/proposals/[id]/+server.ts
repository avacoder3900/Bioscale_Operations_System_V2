import { json, error } from '@sveltejs/kit';
import { connectDB, KanbanTask, AuditLog } from '$lib/server/db';
import { generateId } from '$lib/server/db/utils.js';
import { requireAgentApiKey } from '$lib/server/api-auth';
import type { RequestHandler } from './$types';

export const PATCH: RequestHandler = async ({ request, params }) => {
	requireAgentApiKey(request);
	await connectDB();

	const { id: proposalId } = params;
	const body = await request.json();
	const { decision, reason, editNotes, decidedBy } = body;

	if (!decision || !['approved', 'edited', 'vetoed'].includes(decision)) {
		throw error(400, 'decision is required: approved, edited, or vetoed');
	}

	// Find the task containing this proposal
	const task = await KanbanTask.findOne({ 'proposals._id': proposalId }) as any;
	if (!task) throw error(404, 'Proposal not found');

	const proposal = task.proposals.find((p: any) => p._id === proposalId);
	if (!proposal) throw error(404, 'Proposal not found');

	if (proposal.decision !== 'pending') {
		throw error(400, `Proposal already resolved with decision: ${proposal.decision}`);
	}

	const now = new Date();
	const actor = decidedBy || 'agent';

	await KanbanTask.updateOne(
		{ _id: task._id, 'proposals._id': proposalId },
		{
			$set: {
				'proposals.$.decision': decision,
				'proposals.$.decidedBy': actor,
				'proposals.$.decidedAt': now,
				'proposals.$.editNotes': editNotes || undefined,
				'proposals.$.vetoReason': (decision === 'vetoed' ? reason : undefined)
			},
			$push: {
				activityLog: {
					_id: generateId(),
					action: 'proposal_decided',
					details: { proposalId, decision, reason: reason || undefined },
					createdAt: now,
					createdBy: actor
				}
			}
		}
	);

	await AuditLog.create({
		_id: generateId(),
		tableName: 'kanban_tasks',
		recordId: task._id,
		action: 'UPDATE',
		oldData: { proposalDecision: 'pending' },
		newData: { proposalDecision: decision, proposalId },
		changedFields: ['proposals'],
		changedBy: actor,
		changedAt: now
	});

	return json({
		success: true,
		data: {
			proposalId,
			taskId: task._id,
			decision,
			decidedBy: actor,
			decidedAt: now
		}
	});
};
