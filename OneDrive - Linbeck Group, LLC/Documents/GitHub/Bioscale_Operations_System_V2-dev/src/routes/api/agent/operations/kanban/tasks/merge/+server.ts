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
	const { targetTaskId, sourceTaskId, reason } = body;

	if (!targetTaskId || !sourceTaskId) {
		throw error(400, 'targetTaskId and sourceTaskId are required');
	}
	if (targetTaskId === sourceTaskId) {
		throw error(400, 'Cannot merge a task into itself');
	}

	const [target, source] = await Promise.all([
		KanbanTask.findById(targetTaskId) as any,
		KanbanTask.findById(sourceTaskId) as any
	]);

	if (!target) throw error(404, 'Target task not found');
	if (!source) throw error(404, 'Source task not found');
	if (source.archived) throw error(400, 'Source task is already archived');

	const now = new Date();

	// Merge source description/context into target
	const mergedDescription = [
		target.description || '',
		`\n\n---\n**Merged from: ${source.title}** (${source._id})\n${source.description || '(no description)'}`
	].join('').trim();

	// Merge tags (deduplicate)
	const mergedTags = [...new Set([...(target.tags || []), ...(source.tags || [])])];

	// Update target: absorb source content
	await KanbanTask.findByIdAndUpdate(targetTaskId, {
		$set: {
			description: mergedDescription,
			tags: mergedTags
		},
		$push: {
			activityLog: {
				_id: generateId(),
				action: 'task_merge',
				details: {
					sourceTaskId,
					sourceTitle: source.title,
					reason: reason || 'Duplicate merge'
				},
				createdAt: now,
				createdBy: 'agent'
			}
		}
	});

	// Archive source task
	await KanbanTask.findByIdAndUpdate(sourceTaskId, {
		$set: {
			archived: true,
			archivedAt: now,
			status: 'done'
		},
		$push: {
			activityLog: {
				_id: generateId(),
				action: 'merged_into',
				details: {
					targetTaskId,
					targetTitle: target.title,
					reason: reason || 'Duplicate merge'
				},
				createdAt: now,
				createdBy: 'agent'
			},
			transitions: {
				_id: generateId(),
				fromStatus: source.status,
				toStatus: 'done',
				changedBy: 'agent',
				timestamp: now
			}
		}
	});

	// Audit logs for both
	await Promise.all([
		AuditLog.create({
			_id: generateId(),
			tableName: 'kanban_tasks',
			recordId: targetTaskId,
			action: 'UPDATE',
			newData: { mergedFrom: sourceTaskId, reason: reason || 'Duplicate merge' },
			changedFields: ['description', 'tags'],
			changedBy: 'agent',
			changedAt: now
		}),
		AuditLog.create({
			_id: generateId(),
			tableName: 'kanban_tasks',
			recordId: sourceTaskId,
			action: 'UPDATE',
			oldData: { status: source.status, archived: false },
			newData: { status: 'done', archived: true, mergedInto: targetTaskId },
			changedFields: ['status', 'archived'],
			changedBy: 'agent',
			changedAt: now
		})
	]);

	return json({
		success: true,
		data: {
			targetTaskId,
			sourceTaskId,
			sourceArchived: true,
			reason: reason || 'Duplicate merge'
		}
	});
};
