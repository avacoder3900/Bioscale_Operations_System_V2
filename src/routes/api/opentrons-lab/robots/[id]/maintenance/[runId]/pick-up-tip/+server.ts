/**
 * Load a tiprack + pick up a tip in a maintenance run, so the operator can dial
 * in the deck WITH a tip on (matching the real fill/calibration workflow).
 * POST /api/opentrons-lab/robots/:id/maintenance/:runId/pick-up-tip
 * Body: { pipetteId, tiprackLoadName, slot?, tipWell? }
 * Returns: { tiprackLabwareId }
 */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import { getRobot } from '$lib/server/opentrons/proxy';
import { connectDB, LabwareDefinition } from '$lib/server/db';
import { registerLabwareDefinition, loadLabwareInRun, pickUpTip } from '$lib/server/opentrons/maintenance';

export const config = { maxDuration: 60 };

export const POST: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:write');

	const robot = await getRobot(params.id);
	if (!robot) error(404, 'Robot not found');

	const body = await request.json().catch(() => ({}) as any);
	const pipetteId = body?.pipetteId;
	const tiprackLoadName = body?.tiprackLoadName;
	const slot = String(body?.slot ?? '11');
	const tipWell = body?.tipWell ?? 'A1';
	if (!pipetteId || typeof pipetteId !== 'string') error(400, 'pipetteId required');
	if (!tiprackLoadName || typeof tiprackLoadName !== 'string') error(400, 'tiprackLoadName required');

	await connectDB();
	const def = (await LabwareDefinition.findOne({ loadName: tiprackLoadName }).lean()) as any;
	if (!def?.definition) error(404, `Tiprack "${tiprackLoadName}" not found in BIMS labware library`);
	const namespace = def.namespace ?? def.definition?.namespace;
	const version = Number(def.version ?? def.definition?.version ?? 1);

	try {
		await registerLabwareDefinition(robot, params.runId, def.definition);
		// loadLabwareInRun is idempotent (reuses the slot if already loaded), so a
		// reused maintenance run no longer throws LocationIsOccupiedError here.
		const tiprackLabwareId = await loadLabwareInRun(robot, params.runId, { namespace, loadName: tiprackLoadName, version, slot });
		try {
			await pickUpTip(robot, params.runId, pipetteId, tiprackLabwareId, tipWell);
		} catch (tipErr) {
			// In a reused run the pipette may already hold a tip — that's the desired
			// end state, so treat "tip already attached" as success instead of erroring.
			const msg = tipErr instanceof Error ? tipErr.message : String(tipErr);
			if (!/tip.*(attach|present|already)|already.*tip|should not have a tip/i.test(msg)) throw tipErr;
		}
		return json({ tiprackLabwareId });
	} catch (e) {
		console.error('[API] pick-up-tip error:', e instanceof Error ? e.message : e);
		error(502, e instanceof Error ? e.message : 'Failed to pick up tip');
	}
};
