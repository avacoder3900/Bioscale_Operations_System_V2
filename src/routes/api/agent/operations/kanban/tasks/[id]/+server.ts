import { json, error } from '@sveltejs/kit';
import { connectDB, KanbanTask, KanbanProject, AuditLog } from '$lib/server/db';
import { generateId } from '$lib/server/db/utils.js';
import { requireAgentApiKey } from '$lib/server/api-auth';
import type { RequestHandler } from './$types';

export const PATCH: RequestHandler = async ({ request, params }) => {
	requireAgentApiKey(request);
	await connectDB();

	const { id } = params;
	const task = await KanbanTask.findById(id) as any;
	if (!task) throw error(404, 'Task not found');

	const body = await request.json();
	const { title, description, status, prioritized, taskLength, assignedTo, dueDate, tags, appendContext, projectId } = body;

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
	if (prioritized !== undefined) {
		oldData.prioritized = task.prioritized;
		$set.prioritized = prioritized === true;
		changedFields.push('prioritized');
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

	if (projectId !== undefined) {
		oldData.project = task.project;
		if (projectId) {
			const proj = await KanbanProject.findById(projectId).lean() as any;
			if (proj) {
				$set.project = { _id: proj._id, name: proj.name, color: proj.color };
			}
		} else {
			$set.project = null;
		}
		changedFields.push('project');
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
			prioritized: updated.prioritized ?? false,
			changedFields,
			updatedAt: updated.updatedAt
		}
	});
};
