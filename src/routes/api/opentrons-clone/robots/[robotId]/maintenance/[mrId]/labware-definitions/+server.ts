/**
 * POST /api/opentrons-clone/robots/:robotId/maintenance/:mrId/labware-definitions
 * Registers a custom labware definition onto an existing maintenance run
 * so that a subsequent `loadLabware` command by namespace/loadName/version
 * can resolve it. Required for Brevitest's custom cartridge / wax-tray
 * labware during the LPC wizard.
 *
 * Body: the raw LabwareDefinition2 or LabwareDefinition3 JSON.
 */
import { error, json } from '@sveltejs/kit';
import { connectDB, OpentronsRobot } from '$lib/server/db';
import { registerMaintenanceLabwareDefinition } from '$lib/server/opentrons/maintenance';
import { requirePermission } from '$lib/server/permissions';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	requirePermission(locals.user, 'manufacturing:write');

	await connectDB();
	const robot = (await OpentronsRobot.findById(params.robotId)
		.select('_id ip port')
		.lean()) as { ip: string; port?: number } | null;
	if (!robot) throw error(404, 'Robot not found');

	let definition: unknown;
	try {
		definition = await request.json();
	} catch {
		return json({ error: 'Invalid JSON body' }, { status: 400 });
	}

	try {
		await registerMaintenanceLabwareDefinition(robot, params.mrId as string, definition);
		return json({ ok: true });
	} catch (e) {
		return json({ error: (e as Error).message }, { status: 502 });
	}
};
