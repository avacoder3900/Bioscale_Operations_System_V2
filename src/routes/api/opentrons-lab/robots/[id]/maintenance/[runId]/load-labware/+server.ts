/**
 * Register + load a BIMS labware definition into a maintenance run so move-to-well
 * can resolve it (DECK-CALIBRATION-STUDIO "move to hole").
 * POST /api/opentrons-lab/robots/:id/maintenance/:runId/load-labware
 * Body: { loadName: string, namespace?: string, version?: number, slot?: string }
 * Returns: { labwareId }
 */
import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import { getRobot } from '$lib/server/opentrons/proxy';
import { verbResponse } from '$lib/server/opentrons/transport';
import { resolveLabwareForRobot } from '$lib/server/opentrons/maintenance-records';
import { isHardenedRobot } from '$lib/server/services/deck-calibration/rollout';

// Registers the full (576-well) deck def + loadLabware over the bridge — two
// round-trips with a large payload; exceed Vercel's ~10s default.
export const config = { maxDuration: 60 };

// BIMS half: resolve the definition. Robot half ('mx.loadLabware': register +
// idempotent load) lives in $lib/opentrons/ot2-protocol, shared with the tailnet line.
export const POST: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:write');

	const robot = await getRobot(params.id);
	if (!robot) error(404, 'Robot not found');

	const body = await request.json().catch(() => ({}) as any);
	const loadName = body?.loadName;
	if (!loadName || typeof loadName !== 'string') error(400, 'loadName required');

	let resolved;
	try {
		resolved = await resolveLabwareForRobot(loadName, {
			namespace: body?.namespace ?? null,
			version: body?.version != null ? Number(body.version) : null
		});
	} catch (e) {
		throw error(404, e instanceof Error ? e.message : `Labware definition "${loadName}" not found`);
	}

	return verbResponse(robot, 'mx.loadLabware', {
		runId: params.runId,
		loadName,
		slot: String(body?.slot ?? '1'),
		...resolved,
		hardened: isHardenedRobot(robot)
	});
};
