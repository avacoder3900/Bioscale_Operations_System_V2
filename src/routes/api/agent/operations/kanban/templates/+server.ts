import { json } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB, KanbanTemplate } from '$lib/server/db';
import {
	humanOnlyMessage,
	logMachineActivity,
	HUMAN_ONLY_ACTIONS
} from '$lib/server/machine-actor';
import type { RequestHandler } from './$types';

/** KB2-11: workflow templates. GET = list; writes are human-only (PERM-05). */
export const GET: RequestHandler = async ({ request, url }) => {
	requireAgentApiKey(request);
	await connectDB();
	const filter: any = url.searchParams.get('includeInactive') === '1' ? {} : { active: true };
	const templates = await KanbanTemplate.find(filter).sort({ name: 1 }).lean();
	return json({ success: true, data: { templates: JSON.parse(JSON.stringify(templates)) } });
};

/**
 * PERM-05: template writes are an admin action, and key-authenticated callers are
 * permanent non-admins. The old gate resolved `kanban:admin` against an actor
 * username taken from the request body, so any holder of the shared key could name
 * an admin. Humans edit templates in Kanban → Policy → Templates.
 */
export const POST: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await logMachineActivity({
		keyIdentity: 'agent-shared',
		reportedActor: null,
		channel: 'agent-api',
		tool: 'kanban_set_template',
		path: '/api/agent/operations/kanban/templates',
		method: 'POST',
		ok: false,
		detail: 'refused: human-only'
	});
	return json(
		{
			success: false,
			error: humanOnlyMessage(
				HUMAN_ONLY_ACTIONS.kanban_set_template.what,
				HUMAN_ONLY_ACTIONS.kanban_set_template.where
			)
		},
		{ status: 403 }
	);
};
