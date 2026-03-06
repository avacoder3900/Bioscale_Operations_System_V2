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

export const PATCH: RequestHandler = async ({ request, params }) => {
	requireApiKey(request);
	await connectDB();

	const { id } = params;
	const task = await KanbanTask.findById(id) as any;
	if (!task) throw error(404, 'Task not found');

	const body = await request.json();
	const { title, description, status, priority, taskLength, assignedTo, dueDate, tags, appendContext } = body;

	const $set: any = {};
	const $push: any = {};
	const changedFields: string[] = [];
	const oldData: any = {};
	const now = new Date();

	if (title !== undefined) {
		oldData.title = task.title;
		$set.title = title;
		changedFields.push('title');
	}
	if (description !== undefined) {
		oldData.description = task.description;
		$set.description = description;
		changedFields.push('description');
	}
	if (priority !== undefined) {
		oldData.priority = task.priority;
		$set.priority = priority;
		changedFields.push('priority');
	}
	if (taskLength !== undefined) {
		oldData.taskLength = task.taskLength;
		$set.taskLength = taskLength;
		changedFields.push('taskLength');
	}
	if (dueDate !== undefined) {
		oldData.dueDate = task.dueDate;
		$set.dueDate = dueDate ? new Date(dueDate) : null;
		changedFields.push('dueDate');
	}
	if (tags !== undefined) {
		oldData.tags = task.tags;
		$set.tags = tags;
		changedFields.push('tags');
	}

	if (assignedTo !== undefined) {
		oldData.assignee = task.assignee;
		if (assignedTo) {
			const { User } = await import('$lib/server/db');
			const u = await User.findById(assignedTo).lean() as any;
			if (u) {
				$set.assignee = { _id: u._id, username: u.username };
			}
		} else {
			$set.assignee = null;
		}
		changedFields.push('assignee');
	}

	// Status change — log transition
	if (status !== undefined && status !== task.status) {
		const fromStatus = task.status;
		oldData.status = fromStatus;
		$set.status = status;
		$set.statusChangedAt = now;
		changedFields.push('status');

		// Set date fields for the new status
		const dateField = `${status === 'done' ? 'completed' : status}Date`;
		if (['backlogDate', 'readyDate', 'wipDate', 'waitingDate', 'completedDate'].includes(dateField)) {
			$set[dateField] = now;
		}

		// Push transition record
		if (!$push.$each) $push.transitions = { $each: [] };
		const transitionsPush = {
			_id: generateId(),
			fromStatus,
			toStatus: status,
			changedBy: 'agent',
			timestamp: now
		};
		if ($push.transitions) {
			$push.transitions.$each.push(transitionsPush);
		} else {
			$push.transitions = transitionsPush;
		}

		// Also log to activityLog
		$push.activityLog = {
			_id: generateId(),
			action: 'status_change',
			details: { from: fromStatus, to: status },
			createdAt: now,
			createdBy: 'agent'
		};
	}

	// Append context to description
	if (appendContext) {
		const existing = task.description || '';
		$set.description = existing ? `${existing}\n\n---\n${appendContext}` : appendContext;
		changedFields.push('description');
	}

	if (changedFields.length === 0) {
		return json({ success: true, data: { id: task._id, message: 'No changes applied' } });
	}

	const update: any = {};
	if (Object.keys($set).length > 0) update.$set = $set;
	if (Object.keys($push).length > 0) update.$push = $push;

	const updated = await KanbanTask.findByIdAndUpdate(id, update, { new: true }).lean() as any;

	await AuditLog.create({
		_id: generateId(),
		tableName: 'kanban_tasks',
		recordId: id,
		action: 'UPDATE',
		oldData,
		newData: $set,
		changedFields,
		changedBy: 'agent',
		changedAt: now
	});

	return json({
		success: true,
		data: {
			id: updated._id,
			title: updated.title,
			status: updated.status,
			priority: updated.priority,
			changedFields,
			updatedAt: updated.updatedAt
		}
	});
};
