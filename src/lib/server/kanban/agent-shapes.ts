/**
 * Response shapes shared by the agent-API kanban endpoints (and therefore the
 * MCP tools that proxy them). Kept additive: existing keys never change
 * meaning, new keys are appended so callers can verify writes without a
 * follow-up snapshot read (MCP-IMPROVEMENTS P2-6.1).
 */
import { createKanbanItem, TransitionError, type CreateKanbanItemOptions } from './transition';
import { KanbanTask } from '$lib/server/db';

/** The stored task, echoed back after a capture. */
export function captureEcho(task: any) {
	return {
		id: task._id,
		trackingNumber: task.trackingNumber ?? null,
		title: task.title,
		status: task.status,
		tags: task.tags ?? [],
		parentTaskId: task.parentTaskId ?? null,
		createdAt: task.createdAt,
		// P2-6.1 additive fields
		description: task.description ?? null,
		itemType: task.itemType ?? 'deliverable',
		origin: task.origin ?? 'planned',
		dor: {
			deliverable: task.dor?.deliverable ?? null,
			handoffBrief: task.dor?.handoffBrief ?? null
		},
		dorSet: Boolean(task.dor?.deliverable || task.dor?.handoffBrief),
		links: (task.links ?? []).map((l: any) => ({ linkId: l._id, taskId: l.taskId, type: l.type, note: l.note ?? null }))
	};
}

/**
 * Turn one raw capture payload (as sent by kanban_capture / an item of
 * kanban_capture_bulk / a subtask) into CreateKanbanItemOptions. Throws
 * TransitionError on shape problems so callers can report per item.
 */
export async function captureOptionsFromBody(
	body: any,
	actor: { username: string; via: 'agent-api' | 'mcp' },
	defaults: Partial<CreateKanbanItemOptions> = {}
): Promise<CreateKanbanItemOptions> {
	const title = typeof body?.title === 'string' ? body.title.trim() : '';
	if (!title) throw new TransitionError('REASON_REQUIRED', 'title is required');

	let assignee: CreateKanbanItemOptions['assignee'] = defaults.assignee ?? null;
	if (body.assignedTo) {
		const { User } = await import('$lib/server/db');
		const u = (await User.findById(body.assignedTo).lean()) as any;
		assignee = u ? { _id: u._id, username: u.username } : null;
	}

	const dor =
		body.dor && typeof body.dor === 'object'
			? {
					deliverable: typeof body.dor.deliverable === 'string' ? body.dor.deliverable : undefined,
					handoffBrief: typeof body.dor.handoffBrief === 'string' ? body.dor.handoffBrief : undefined
				}
			: undefined;

	return {
		title,
		description: typeof body.description === 'string' && body.description ? body.description : defaults.description,
		origin: body.origin === 'discovered' ? 'discovered' : defaults.origin ?? 'planned',
		spawnedFrom: body.spawnedFrom || defaults.spawnedFrom,
		itemType: ['deliverable', 'spike', 'chore', 'milestone'].includes(body.itemType) ? body.itemType : defaults.itemType,
		spike: body.spike || undefined,
		// KB2-27: workshopped estimate (working days) — plan imports set it at capture.
		estimateDays:
			typeof body.estimateDays === 'number' && body.estimateDays > 0 ? body.estimateDays : undefined,
		// KB2-31: hands-on effort when it differs from duration.
		effortDays:
			typeof body.effortDays === 'number' && body.effortDays > 0 ? body.effortDays : undefined,
		dor,
		assignee,
		dueDate: body.dueDate ? new Date(body.dueDate) : defaults.dueDate,
		source: body.source || defaults.source || 'agent',
		sourceRef: body.sourceRef || defaults.sourceRef,
		tags: Array.isArray(body.tags) ? body.tags : defaults.tags ?? [],
		parentTaskId: body.parentTaskId || defaults.parentTaskId,
		links: Array.isArray(body.links) ? body.links : undefined,
		blockedBy: Array.isArray(body.blockedBy) ? body.blockedBy.filter((x: unknown) => typeof x === 'string') : undefined,
		actor
	};
}

/** Create one item and return its echo; used by single + bulk + subtasks. */
export async function captureOne(opts: CreateKanbanItemOptions) {
	const created = await createKanbanItem(opts);
	const task = (await KanbanTask.findById(created._id).lean()) as any;
	return captureEcho(task ?? created);
}
