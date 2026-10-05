/**
 * The BIMS half of a maintenance verb the browser ran on the robot over the
 * tailnet (OT2-TAILNET-4). The queue-line routes write the same records inline
 * (verbResponse → applyMaintenanceRecord); this is that call for the other line.
 * POST /api/opentrons-lab/robots/:id/direct-record   Body: { record: MaintenanceRecord }
 * → extra response fields (e.g. { nextTipWell })
 *
 * Never touches the robot. Only the three known record kinds are accepted.
 */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, OpentronsRobot } from '$lib/server/db';
import { applyMaintenanceRecord } from '$lib/server/opentrons/maintenance-records';
import type { MaintenanceRecord } from '$lib/opentrons/ot2-protocol';

const str = (v: unknown, max = 200) => (typeof v === 'string' && v.length <= max ? v : undefined);

function parseRecord(raw: any): MaintenanceRecord | null {
	switch (raw?.event) {
		case 'maintenance_run_open': {
			const runId = str(raw.runId);
			if (!runId) return null;
			return { event: raw.event, runId, pipetteId: str(raw.pipetteId), pipetteName: str(raw.pipetteName), mount: str(raw.mount, 10) };
		}
		case 'maintenance_run_close': {
			const runId = str(raw.runId);
			return runId ? { event: raw.event, runId } : null;
		}
		case 'studio_tip_pickup': {
			const tiprackLoadName = str(raw.tiprackLoadName);
			const tipWell = str(raw.tipWell, 8);
			return tiprackLoadName && tipWell ? { event: raw.event, tiprackLoadName, tipWell } : null;
		}
	}
	return null;
}

export const POST: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:write');

	const body = await request.json().catch(() => ({}) as any);
	const rec = parseRecord(body?.record);
	if (!rec) error(400, 'record must be maintenance_run_open | maintenance_run_close | studio_tip_pickup');

	await connectDB();
	if (!(await OpentronsRobot.exists({ _id: params.id }))) error(404, 'Robot not found');

	return json(await applyMaintenanceRecord(params.id, locals.user.username, rec, 'tailnet'));
};
