import { json, error } from '@sveltejs/kit';
import { connectDB, KanbanTask, KanbanProject, AuditLog } from '$lib/server/db';
import { generateId } from '$lib/server/db/utils.js';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { transitionTask, TransitionError } from '$lib/server/kanban/transition';
import { SIZE_CLASSES } from '$lib/shared/kanban-status';
import type { RequestHandler } from './$types';

export const PATCH: RequestHandler = async ({ request, params }) => {
	requireAgentApiKey(request);
	await connectDB();

	const { id } = params;
	const task = await KanbanTask.findById(id) as any;
	if (!task) throw error(404, 'Task not found');

	const body = await request.json();
	const {
		title, description, status, sizeClass, assignedTo, dueDate, tags,
		appendContext, projectId, actor, reason, waitingOn, waitingUntil
	} = body;

	const actorName = typeof actor === 'string' && actor.trim() ? actor.trim() : 'agent';

	const $set: any = {};
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
	if (sizeClass !== undefined) {
		if (sizeClass !== null && !(SIZE_CLASSES as readonly string[]).includes(sizeClass)) {
			throw error(400, `sizeClass must be one of: ${SIZE_CLASSES.join(', ')}`);
		}
		oldData.sizeClass = task.sizeClass;
		$set.sizeClass = sizeClass;
		changedFields.push('sizeClass');
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
			// Look up project to get name and color
			const proj = await KanbanProject.findById(projectId).lean() as any;
			if (proj) {
				$set.project = { _id: proj._id, name: proj.name, color: proj.color };
			} else {
				// Fallback: set project with just the ID (name will be missing but at least it's assigned)
				$set.project = { _id: projectId, name: 'Unknown', color: '#808080' };
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

	// Append context to description
	if (appendContext) {
		const existing = task.description || '';
		$set.description = existing ? `${existing}\n\n---\n${appendContext}` : appendContext;
		if (!changedFields.includes('description')) changedFields.push('description');
	}

	const wantsStatusChange = status !== undefined && status !== task.status;

	if (changedFields.length === 0 && !wantsStatusChange) {
		return json({ success: true, data: { id: task._id, message: 'No changes applied' } });
	}

	// Apply non-status field updates first (so e.g. an assignee change is in
	// effect before the WIP-limit guard runs on a simultaneous status change).
	if (Object.keys($set).length > 0) {
		await KanbanTask.findByIdAndUpdate(id, { $set }, { new: true });

		await AuditLog.create({
			_id: generateId(),
			tableName: 'kanban_tasks',
			recordId: id,
			action: 'UPDATE',
			oldData,
			newData: $set,
			changedFields,
			changedBy: actorName,
			changedAt: now
		});
	}

	// Status changes go through the transition service — tier crossings,
	// WIP limits, and blocked/waiting guards are enforced there and any
	// violation surfaces as a 400 with the service's message.
	if (wantsStatusChange) {
		try {
			await transitionTask({
				taskId: id,
				to: status,
				actor: { username: actorName, via: 'agent-api' },
				reason: typeof reason === 'string' ? reason : undefined,
				waitingOn: typeof waitingOn === 'string' ? waitingOn : undefined,
				waitingUntil: waitingUntil ? new Date(waitingUntil) : undefined
			});
		} catch (e) {
			if (e instanceof TransitionError) {
				return json({ error: e.message, code: e.code }, { status: 400 });
			}
			throw e;
		}
		oldData.status = task.status;
		changedFields.push('status');
	}

	const updated = await KanbanTask.findById(id).lean() as any;

	return json({
		success: true,
		data: {
			id: updated._id,
			title: updated.title,
			status: updated.status,
			changedFields,
			updatedAt: updated.updatedAt
		}
	});
};
