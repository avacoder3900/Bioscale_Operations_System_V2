/**
 * Load a tiprack + pick up a tip in a maintenance run, so the operator can dial
 * in the deck WITH a tip on (matching the real fill/calibration workflow).
 * POST /api/opentrons-lab/robots/:id/maintenance/:runId/pick-up-tip
 * Body: { pipetteId, tiprackLoadName, slot?, tipWell? }
 * Returns: { tiprackLabwareId }
 */
import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import { getRobot } from '$lib/server/opentrons/proxy';
import { verbResponse } from '$lib/server/opentrons/transport';
import { resolveLabwareForRobot } from '$lib/server/opentrons/maintenance-records';
import { isHardenedRobot } from '$lib/server/services/deck-calibration/rollout';

export const config = { maxDuration: 60 };

// BIMS half before: resolve the tiprack; after: advance the Studio tip cursor
// (nextTipWell). Robot half ('mx.pickUpTip': register, idempotent load, pick up,
// TIP_ALREADY_ATTACHED / SLOT_OCCUPIED 409s) is in $lib/opentrons/ot2-protocol —
// all shared with the tailnet line.
export const POST: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:write');

	const robot = await getRobot(params.id);
	if (!robot) error(404, 'Robot not found');

	const body = await request.json().catch(() => ({}) as any);
	const pipetteId = body?.pipetteId;
	const tiprackLoadName = body?.tiprackLoadName;
	if (!pipetteId || typeof pipetteId !== 'string') error(400, 'pipetteId required');
	if (!tiprackLoadName || typeof tiprackLoadName !== 'string') error(400, 'tiprackLoadName required');

	let resolved;
	try {
		resolved = await resolveLabwareForRobot(tiprackLoadName);
	} catch (e) {
		throw error(404, e instanceof Error ? e.message : `Tiprack "${tiprackLoadName}" not found`);
	}

	return verbResponse(
		robot,
		'mx.pickUpTip',
		{
			runId: params.runId,
			pipetteId,
			tiprackLoadName,
			slot: String(body?.slot ?? '11'),
			tipWell: body?.tipWell ?? 'A1',
			...resolved,
			hardened: isHardenedRobot(robot)
		},
		locals.user
	);
};
