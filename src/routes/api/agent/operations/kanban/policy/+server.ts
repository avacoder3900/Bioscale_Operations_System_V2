import { json } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { getKanbanPolicy } from '$lib/server/kanban/policy';
import {
	humanOnlyMessage,
	logMachineActivity,
	HUMAN_ONLY_ACTIONS
} from '$lib/server/machine-actor';
import type { RequestHandler } from './$types';

/** KB2-04: read the policy (every tunable of the two-tier system). */
export const GET: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	const policy = await getKanbanPolicy();
	return json({ success: true, data: JSON.parse(JSON.stringify(policy)) });
};

/**
 * KB2-04 policy tuning moved to the web UI only (PERM-05). The editable-path
 * allowlist now lives with the human-facing action in
 * src/routes/kanban/policy/+page.server.ts.
 */

export const PATCH: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);

	// PERM-05: changing kanban policy is an admin action, and key-authenticated
	// callers are permanent non-admins. The previous gate looked up kanban:admin on
	// an actor username supplied in the REQUEST BODY — anyone holding the shared key
	// could simply name an admin. Authorization by self-declaration is not
	// authorization, so the path is closed: a human edits policy in Kanban → Policy.
	await logMachineActivity({
		keyIdentity: 'agent-shared',
		reportedActor: null,
		channel: 'agent-api',
		tool: 'kanban_set_policy',
		path: '/api/agent/operations/kanban/policy',
		method: 'PATCH',
		ok: false,
		detail: 'refused: human-only'
	});
	return json(
		{
			success: false,
			error: humanOnlyMessage(
				HUMAN_ONLY_ACTIONS.kanban_set_policy.what,
				HUMAN_ONLY_ACTIONS.kanban_set_policy.where
			)
		},
		{ status: 403 }
	);
};
