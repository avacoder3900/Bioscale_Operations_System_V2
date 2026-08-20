import { json, error } from '@sveltejs/kit';
import { connectDB, KanbanTask, AuditLog } from '$lib/server/db';
import { generateId } from '$lib/server/db/utils.js';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { transitionTask, TransitionError, addLink, removeLink, setParent, readLinks } from '$lib/server/kanban/transition';
import { normalizeTags } from '$lib/server/kanban/tags';
import { SIZE_CLASSES, isKanbanLinkType } from '$lib/shared/kanban-status';
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
		appendContext, actor, reason, waitingOn, waitingUntil,
		sourceRef, dor, links, blockedBy, removeLinkId, parentTaskId,
		estimateDays
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
	// KB2-27: workshopped estimate in working days; null clears it.
	if (estimateDays !== undefined) {
		if (estimateDays !== null && !(typeof estimateDays === 'number' && estimateDays > 0)) {
			throw error(400, 'estimateDays must be a positive number of working days (or null to clear)');
		}
		oldData.estimateDays = task.estimateDays;
		$set.estimateDays = estimateDays;
		changedFields.push('estimateDays');
	}
	if (dueDate !== undefined) {
		oldData.dueDate = task.dueDate;
		$set.dueDate = dueDate ? new Date(dueDate) : null;
		changedFields.push('dueDate');
	}
	if (tags !== undefined) {
		// P1-3: tag hygiene on every write path — trim, case-fold onto the
		// existing vocabulary, de-dupe.
		oldData.tags = task.tags;
		$set.tags = await normalizeTags(tags);
		changedFields.push('tags');
	}
	if (sourceRef !== undefined) {
		// KB2-08 linkage conventions: pr:<number>, branch:<name>, commit:<sha>
		oldData.sourceRef = task.sourceRef;
		$set.sourceRef = sourceRef || null;
		changedFields.push('sourceRef');
	}
	if (dor !== undefined && dor !== null && typeof dor === 'object') {
		for (const k of ['deliverable', 'handoffBrief'] as const) {
			if (dor[k] !== undefined) {
				$set[`dor.${k}`] = dor[k];
				changedFields.push(`dor.${k}`);
			}
		}
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

	// P1-4: links (typed) + blockedBy (sugar → blocked_by) + removeLinkId.
	// P1-5: parentTaskId (null detaches). All go through the transition-service
	// helpers so cycle/self/depth checks and audit rows are the same as the UI's.
	const actorObj = { username: actorName, via: 'agent-api' as const };
	const linkResults: any[] = [];
	const wantsLinks = Array.isArray(links) || Array.isArray(blockedBy) || typeof removeLinkId === 'string';
	const wantsParent = parentTaskId !== undefined;
	try {
		if (Array.isArray(links)) {
			for (const l of links) {
				if (!l || typeof l.taskId !== 'string') throw error(400, 'each link needs a taskId');
				if (l.type !== undefined && !isKanbanLinkType(l.type)) throw error(400, `Unknown link type '${l.type}'`);
				linkResults.push({ taskId: l.taskId, type: l.type ?? 'relates_to', ...(await addLink(id, l, actorObj)) });
			}
		}
		if (Array.isArray(blockedBy)) {
			for (const bid of blockedBy) {
				if (typeof bid !== 'string') continue;
				linkResults.push({ taskId: bid, type: 'blocked_by', ...(await addLink(id, { taskId: bid, type: 'blocked_by' }, actorObj)) });
			}
		}
		if (typeof removeLinkId === 'string' && removeLinkId) {
			linkResults.push({ linkId: removeLinkId, ...(await removeLink(id, removeLinkId, actorObj)) });
		}
		if (wantsParent) {
			const r = await setParent(id, parentTaskId === null ? null : String(parentTaskId), actorObj);
			if (r.changed) changedFields.push('parentTaskId');
		}
	} catch (e) {
		if (e instanceof TransitionError) return json({ error: e.message, code: e.code }, { status: 400 });
		throw e;
	}
	if (linkResults.some((r) => r.added || r.removed)) changedFields.push('links');

	if (changedFields.length === 0 && !wantsStatusChange && !wantsLinks && !wantsParent) {
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
			trackingNumber: updated.trackingNumber ?? null,
			title: updated.title,
			status: updated.status,
			changedFields,
			updatedAt: updated.updatedAt,
			// Additive echoes so callers can verify without a snapshot read.
			tags: updated.tags ?? [],
			parentTaskId: updated.parentTaskId ?? null,
			dor: { deliverable: updated.dor?.deliverable ?? null, handoffBrief: updated.dor?.handoffBrief ?? null },
			links: wantsLinks ? await readLinks(id) : undefined,
			linkResults: linkResults.length ? linkResults : undefined
		}
	});
};
