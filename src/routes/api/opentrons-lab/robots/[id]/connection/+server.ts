/**
 * Which line should the browser use for this robot? (OT2-TAILNET-4)
 * GET /api/opentrons-lab/robots/:id/connection
 *
 * → { transport: 'tailnet'|'queue', directUrl?, reason, hardened, busy: { kind, since } | null,
 *     bridgeJobs: boolean }
 *
 * The browser session ($lib/opentrons/direct-client) calls this once per page,
 * then probes directUrl itself — only the browser can tell whether IT is on the
 * tailnet. `busy` names a running daemon job (sweep / deck scan / tip calibrate):
 * the queue serializes those with everything else for this robot, direct calls
 * would not, so motion defers to the queue while one runs.
 *
 * `bridgeJobs` (OT2-TAILNET-5 §7.3/§7.5) = bridgeJobGate(robot).ok on THIS
 * deployment: the two-key tailnet gate AND OT2_BRIDGE_TOKEN_SECRET is set. Only
 * then can a tailnet browser get a /bridge token, so only then does
 * RobotSession.bridge() hand pages a daemon-job client; otherwise pages keep
 * their queue path. Always false on the queue line.
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, Ot2BridgeCommand } from '$lib/server/db';
import { getRobot } from '$lib/server/opentrons/proxy';
import { resolveRobotConnection } from '$lib/server/opentrons/connection';
import { bridgeJobGate } from '$lib/server/opentrons/bridge-token';
import { isHardenedRobot } from '$lib/server/services/deck-calibration/rollout';

/** Daemon jobs that hold the gantry for longer than one command. */
const LONG_JOB_KINDS = ['sweep', 'deck_scan', 'calibrate_tip'];
/** A claimed job older than this is treated as dead (daemon crashed mid-job). */
const BUSY_MAX_AGE_MS = 30 * 60 * 1000;

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:read');

	const robot = await getRobot(params.id);
	if (!robot) error(404, 'Robot not found');

	const conn = resolveRobotConnection(robot);

	await connectDB();
	const job = (await Ot2BridgeCommand.findOne(
		{
			robotId: robot._id,
			kind: { $in: LONG_JOB_KINDS },
			status: { $in: ['pending', 'claimed'] },
			createdAt: { $gte: new Date(Date.now() - BUSY_MAX_AGE_MS) }
		},
		{ kind: 1, createdAt: 1, claimedAt: 1 }
	)
		.sort({ createdAt: -1 })
		.lean()) as any;

	return json({
		transport: conn.transport,
		directUrl: conn.directUrl,
		reason: conn.reason,
		// DECK_HARDENING_ROBOT_IDS status — the labware verbs' reuse rule, decided here
		// so the browser's tailnet line applies exactly the rule the queue route would.
		hardened: isHardenedRobot(robot),
		busy: job ? { kind: job.kind, since: job.claimedAt ?? job.createdAt } : null,
		bridgeJobs: bridgeJobGate(robot).ok
	});
};
