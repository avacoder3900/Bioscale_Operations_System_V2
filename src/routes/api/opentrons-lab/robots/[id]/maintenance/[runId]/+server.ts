/**
 * Close a maintenance run on the OT-2.
 * DELETE /api/opentrons-lab/robots/:id/maintenance/:runId
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, AuditLog, generateId } from '$lib/server/db';
import { getRobot } from '$lib/server/opentrons/proxy';
import { closeMaintenanceRun } from '$lib/server/opentrons/maintenance';

// Closing routes through the bridge (up to ~30s); exceed Vercel's ~10s default.
export const config = { maxDuration: 45 };

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:write');

	const robot = await getRobot(params.id);
	if (!robot) error(404, 'Robot not found');

	try {
		await closeMaintenanceRun(robot, params.runId);
		await connectDB();
		await AuditLog.create({
			_id: generateId(),
			tableName: 'opentrons_robots',
			recordId: params.id,
			action: 'maintenance_run_close',
			newData: { runId: params.runId },
			changedAt: new Date(),
			changedBy: locals.user.username
		});
		return json({ ok: true });
	} catch (e) {
		if ((e as any).status) throw e;
		console.error('[API] close maintenance run error:', e instanceof Error ? e.message : e);
		error(502, e instanceof Error ? e.message : 'Failed to close maintenance run');
	}
};
