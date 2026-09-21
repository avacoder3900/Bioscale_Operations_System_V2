import { json } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import { transitionTask, TransitionError } from '$lib/server/kanban/transition';
import { isKanbanStatus } from '$lib/shared/kanban-status';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	requirePermission(locals.user, 'kanban:write');
	await connectDB();

	const { taskId, newStatus, reason, waitingOn, waitingUntil } = await request.json();
	if (!taskId || !newStatus) return json({ error: 'Missing taskId or newStatus' }, { status: 400 });
	if (!isKanbanStatus(newStatus)) return json({ error: `'${newStatus}' is not a valid status` }, { status: 400 });

	try {
		await transitionTask({
			taskId,
			to: newStatus,
			actor: { username: locals.user.username, via: 'ui' },
			reason: reason || undefined,
			waitingOn: waitingOn || undefined,
			waitingUntil: waitingUntil ? new Date(waitingUntil) : undefined
		});
	} catch (e) {
		if (e instanceof TransitionError) {
			// Preserve the 409 shape the board UI expects for the WIP-limit modal.
			if (e.code === 'WIP_LIMIT_EXCEEDED') return json(e.details, { status: 409 });
			if (e.code === 'NOT_FOUND') return json({ error: e.message }, { status: 404 });
			return json({ error: e.message, code: e.code }, { status: 400 });
		}
		throw e;
	}

	return json({ success: true });
};
