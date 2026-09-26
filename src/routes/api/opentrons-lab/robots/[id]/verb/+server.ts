/**
 * Queue-line endpoint for the OT2-TAILNET-5 run-lifecycle verbs.
 * POST /api/opentrons-lab/robots/:id/verb?verb=<verb>[&rid=<runId>][&runId=<maintenanceRunId>]
 * Body: the verb's JSON args (the session strips rid/runId into the query).
 *
 * The verbs themselves (run.list, run.create, run.stop, run.commands,
 * run.ensureFresh, run.uploadProtocol, mx.command) live once in
 * $lib/opentrons/ot2-protocol. This route is what a RobotSession falls back to
 * (verbRoute → callRoute) when its direct line drops mid-call, so the same verb
 * then answers through the Ot2BridgeCommand queue with the same status + body.
 * Only those verbs are served here: the older verbs keep their own routes.
 */
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import { getRobot } from '$lib/server/opentrons/proxy';
import { verbResponse } from '$lib/server/opentrons/transport';
import { LIFECYCLE_VERBS, READ_ONLY_VERBS, type Ot2Verb } from '$lib/opentrons/ot2-protocol';

// run.uploadProtocol over the bridge waits up to 110 s for upload + analysis, and
// the post-upload freshness verify may wait 120 s for an analysis to complete.
export const config = { maxDuration: 300 };

export const POST: RequestHandler = async ({ params, locals, request, url }) => {
	if (!locals.user) error(401, 'Not authenticated');
	const verb = url.searchParams.get('verb') ?? '';
	if (!LIFECYCLE_VERBS.has(verb as Ot2Verb)) {
		return json({ message: `verb ${verb || '(none)'} is not served by this route` }, { status: 400 });
	}
	requirePermission(locals.user, READ_ONLY_VERBS.has(verb as Ot2Verb) ? 'manufacturing:read' : 'manufacturing:write');

	const robot = await getRobot(params.id);
	if (!robot) error(404, 'Robot not found');

	const body = await request.json().catch(() => ({}));
	const args: Record<string, unknown> = body && typeof body === 'object' && !Array.isArray(body) ? { ...body } : {};
	const rid = url.searchParams.get('rid');
	const runId = url.searchParams.get('runId');
	if (rid) args.rid = rid;
	if (runId) args.runId = runId;

	return verbResponse(robot, verb as Ot2Verb, args, { username: locals.user.username });
};
