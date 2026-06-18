/**
 * Register + load a BIMS labware definition into a maintenance run so move-to-well
 * can resolve it (DECK-CALIBRATION-STUDIO "move to hole").
 * POST /api/opentrons-lab/robots/:id/maintenance/:runId/load-labware
 * Body: { loadName: string, namespace?: string, version?: number, slot?: string }
 * Returns: { labwareId }
 */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import { getRobot } from '$lib/server/opentrons/proxy';
import { connectDB, LabwareDefinition } from '$lib/server/db';
import { registerLabwareDefinition, loadLabwareInRun } from '$lib/server/opentrons/maintenance';

export const POST: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:write');

	const robot = await getRobot(params.id);
	if (!robot) error(404, 'Robot not found');

	const body = await request.json().catch(() => ({}) as any);
	const loadName = body?.loadName;
	const slot = String(body?.slot ?? '1');
	if (!loadName || typeof loadName !== 'string') error(400, 'loadName required');

	await connectDB();
	const def = (await LabwareDefinition.findOne({ loadName }).lean()) as any;
	if (!def?.definition) error(404, `Labware definition "${loadName}" not found`);

	const namespace = body?.namespace ?? def.namespace ?? def.definition?.namespace;
	const version = Number(body?.version ?? def.version ?? def.definition?.version ?? 1);

	try {
		await registerLabwareDefinition(robot, params.runId, def.definition);
		const labwareId = await loadLabwareInRun(robot, params.runId, { namespace, loadName, version, slot });
		return json({ labwareId });
	} catch (e) {
		console.error('[API] load-labware error:', e instanceof Error ? e.message : e);
		error(502, e instanceof Error ? e.message : 'Failed to load labware');
	}
};
