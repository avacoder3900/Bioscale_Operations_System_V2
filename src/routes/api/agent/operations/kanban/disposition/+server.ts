import { json } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB } from '$lib/server/db';
import { iceboxTask, declineTask, thawTask } from '$lib/server/kanban/process';
import { TransitionError } from '$lib/server/kanban/transition';
import type { RequestHandler } from './$types';

/** KB2-03: Tier-1 dispositions — icebox (park), decline (reason kept for the record), thaw (un-park). */
export const POST: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await connectDB();
	const body = await request.json();
	const { taskId, action, actor, reason } = body;

	if (!taskId) return json({ success: false, error: 'taskId is required' }, { status: 400 });
	if (!actor?.trim()) return json({ success: false, error: 'actor (username) is required' }, { status: 400 });

	try {
		const common = { taskId, actorUsername: actor.trim(), via: 'mcp' as const };
		if (action === 'icebox') await iceboxTask({ ...common, reason });
		else if (action === 'decline') await declineTask({ ...common, reason });
		else if (action === 'thaw') await thawTask(common);
		else return json({ success: false, error: "action must be 'icebox' | 'decline' | 'thaw'" }, { status: 400 });
		return json({ success: true, data: { taskId, action } });
	} catch (e) {
		if (e instanceof TransitionError) {
			return json({ success: false, error: e.message, code: e.code }, { status: e.code === 'NOT_FOUND' ? 404 : 400 });
		}
		throw e;
	}
};
