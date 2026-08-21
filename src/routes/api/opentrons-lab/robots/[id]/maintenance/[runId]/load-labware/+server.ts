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
import { resolveLabwareDefinition } from '$lib/server/services/deck-calibration/resolve';
import { registerLabwareDefinition, loadLabwareInRun } from '$lib/server/opentrons/maintenance';

// Registers the full (576-well) deck def + loadLabware over the bridge — two
// round-trips with a large payload; exceed Vercel's ~10s default.
export const config = { maxDuration: 60 };

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
	let def: any;
	try {
		({ doc: def } = await resolveLabwareDefinition(loadName, {
			namespace: body?.namespace ?? null,
			version: body?.version != null ? Number(body.version) : null,
			strict: true
		}));
	} catch (e) {
		throw error(404, e instanceof Error ? e.message : `Labware definition "${loadName}" not found`);
	}

	// Identity must come from the blob we are about to register, not from the
	// Mongo columns. registerLabwareDefinition sends `def.definition`, and the
	// robot indexes it by the namespace/version INSIDE that JSON — so if the
	// columns ever drift from the blob, loadLabware would ask for a definition
	// the robot does not have under that URI.
	const namespace = def.definition?.namespace ?? def.namespace;
	const version = Number(def.definition?.version ?? def.version ?? 1);

	try {
		await registerLabwareDefinition(robot, params.runId, def.definition);
		const labwareId = await loadLabwareInRun(robot, params.runId, { namespace, loadName, version, slot });
		return json({ labwareId });
	} catch (e) {
		console.error('[API] load-labware error:', e instanceof Error ? e.message : e);
		error(502, e instanceof Error ? e.message : 'Failed to load labware');
	}
};
