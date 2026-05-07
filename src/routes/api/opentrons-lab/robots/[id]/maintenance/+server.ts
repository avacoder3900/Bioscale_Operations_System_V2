/**
 * Open a maintenance run on the OT-2.
 * POST /api/opentrons-lab/robots/:id/maintenance
 * Body (optional): { pipetteName?: string, mount?: 'left'|'right' }
 *
 * Response: { runId, pipetteId?, pipetteName?, mount? }
 *
 * If pipetteName + mount aren't provided, the server discovers a mounted
 * pipette via the OT-2's /pipettes endpoint. A pipette is required to use
 * moveRelative / moveToCoordinates inside the run.
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, AuditLog, generateId } from '$lib/server/db';
import { getRobot } from '$lib/server/opentrons/proxy';
import {
	openMaintenanceRun,
	discoverPipette,
	loadPipetteInRun
} from '$lib/server/opentrons/maintenance';

export const POST: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:write');

	const robot = await getRobot(params.id);
	if (!robot) error(404, 'Robot not found');

	const body = await request.json().catch(() => ({} as any));
	let pipetteName: string | undefined = body?.pipetteName;
	let mount: 'left' | 'right' | undefined = body?.mount;

	if (!pipetteName || !mount) {
		const discovered = await discoverPipette(robot);
		if (discovered) {
			pipetteName = pipetteName ?? discovered.pipetteName;
			mount = mount ?? discovered.mount;
		}
	}

	try {
		const { runId } = await openMaintenanceRun(robot);
		let pipetteId: string | undefined;
		if (pipetteName && mount) {
			try {
				pipetteId = await loadPipetteInRun(robot, runId, pipetteName, mount);
			} catch (e) {
				// Pipette load failed — return the run anyway so the caller can
				// still home or close it. The error is surfaced for diagnostics.
				console.warn(
					'[maintenance] loadPipette failed:',
					e instanceof Error ? e.message : e
				);
			}
		}

		await connectDB();
		await AuditLog.create({
			_id: generateId(),
			tableName: 'opentrons_robots',
			recordId: params.id,
			action: 'maintenance_run_open',
			newData: { runId, pipetteId, pipetteName, mount },
			changedAt: new Date(),
			changedBy: locals.user.username
		});

		return json({ runId, pipetteId, pipetteName, mount });
	} catch (e) {
		if ((e as any).status) throw e;
		console.error('[API] open maintenance run error:', e instanceof Error ? e.message : e);
		error(502, e instanceof Error ? e.message : 'Failed to open maintenance run');
	}
};
