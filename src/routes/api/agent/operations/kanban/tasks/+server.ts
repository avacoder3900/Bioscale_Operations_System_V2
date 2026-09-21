import { json, error } from '@sveltejs/kit';
import { connectDB, KanbanTask } from '$lib/server/db';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { TransitionError } from '$lib/server/kanban/transition';
import { ReplenishError } from '$lib/server/kanban/replenish';
import { captureTask, isCaptureLanding } from '$lib/server/kanban/capture';
import { captureOptionsFromBody, captureEcho } from '$lib/server/kanban/agent-shapes';
import { SIZE_CLASSES, CLASSES_OF_SERVICE } from '$lib/shared/kanban-status';
import type { RequestHandler } from './$types';

/**
 * Capture one option (kanban_capture). body.status is deliberately ignored;
 * KB2-38 adds `landing` ('captured' default | 'processed' | 'committed') and
 * `position` (1-based slot in the landing list, blank = bottom). 'committed'
 * still crosses the commitment point through replenish() — the actor must be
 * a human holding kanban:replenish (KB2-00 #6, KB2-02), the DoR must be
 * complete, and the ready cap applies — all checked before anything is
 * written. Accepts dor / links / blockedBy at capture (MCP-IMPROVEMENTS
 * P0-1, P1-4) and echoes the stored task (P2-6.1).
 */
export const POST: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await connectDB();

	const body = await request.json();
	const { title, actor, parentTaskId } = body;

	if (!title?.trim() && !body.templateId) throw error(400, 'title is required (unless capturing from a template)');

	if (parentTaskId) {
		const parent = await KanbanTask.findById(parentTaskId).lean();
		if (!parent) throw error(404, 'Parent task not found');
	}

	const actorName = typeof actor === 'string' && actor.trim() ? actor.trim() : 'agent';

	// KB2-11: capture from a workflow template — lands processed + DoR-complete.
	if (typeof body.templateId === 'string' && body.templateId.trim()) {
		const { captureFromTemplate } = await import('$lib/server/kanban/process');
		try {
			const result = await captureFromTemplate({
				templateId: body.templateId.trim(),
				actorUsername: actorName,
				via: 'agent-api',
				title: typeof title === 'string' ? title : undefined,
				dueDate: body.dueDate ? new Date(body.dueDate) : undefined
			});
			return json({ success: true, data: { id: result.taskId, title: result.title, status: 'processed', template: result.templateName } }, { status: 201 });
		} catch (e) {
			if (e instanceof TransitionError) throw error(400, e.message);
			throw e;
		}
	}

	if (body.landing !== undefined && !isCaptureLanding(body.landing)) {
		throw error(400, "landing must be 'captured', 'processed' or 'committed'");
	}
	if (body.sizeClass !== undefined && !(SIZE_CLASSES as readonly string[]).includes(body.sizeClass)) {
		throw error(400, `sizeClass must be one of ${SIZE_CLASSES.join('/')}`);
	}
	if (
		body.classOfService !== undefined &&
		!(CLASSES_OF_SERVICE as readonly string[]).includes(body.classOfService)
	) {
		throw error(400, `classOfService must be one of ${CLASSES_OF_SERVICE.join('/')}`);
	}

	try {
		const opts = await captureOptionsFromBody(body, { username: actorName, via: 'agent-api' });
		const result = await captureTask({
			...opts,
			landing: body.landing,
			position: typeof body.position === 'number' ? body.position : undefined,
			sizeClass: body.sizeClass,
			classOfService: body.classOfService,
			commitNote: typeof body.commitNote === 'string' ? body.commitNote : undefined
		});
		const task = (await KanbanTask.findById(result.taskId).lean()) as any;
		const data = {
			...captureEcho(task),
			landing: result.landing,
			position: result.position,
			...(result.replenish ? { replenish: result.replenish } : {})
		};
		return json({ success: true, data }, { status: 201 });
	} catch (e) {
		if (e instanceof TransitionError) throw error(400, e.message);
		if (e instanceof ReplenishError) throw error(e.code === 'PERMISSION_DENIED' ? 403 : 400, e.message);
		throw e;
	}
};
