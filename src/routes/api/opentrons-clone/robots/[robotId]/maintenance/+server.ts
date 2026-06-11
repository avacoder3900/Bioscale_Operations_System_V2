/**
 * POST   /api/opentrons-clone/robots/:robotId/maintenance       — create a new maintenance run (ending any orphan first)
 * DELETE /api/opentrons-clone/robots/:robotId/maintenance?id=.. — end a specific maintenance run
 *
 * The OT-2 only holds one maintenance run at a time; creating a new one is
 * gated by POSTing after tearing down any existing current_run.
 */
import { error, json } from '@sveltejs/kit';
import { connectDB, OpentronsRobot } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import {
	createMaintenanceRun,
	endMaintenanceRun,
	endOrphanMaintenanceRuns
} from '$lib/server/opentrons/maintenance';
import type { RequestHandler } from './$types';

interface RobotDoc {
	ip: string;
	port?: number;
}

async function getRobot(robotId: string): Promise<RobotDoc> {
	await connectDB();
	const robot = (await OpentronsRobot.findById(robotId)
		.select('_id ip port')
		.lean()) as RobotDoc | null;
	if (!robot) throw error(404, 'Robot not found');
	return robot;
}

export const POST: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	requirePermission(locals.user, 'manufacturing:write');

	const robot = await getRobot(params.robotId as string);

	try {
		await endOrphanMaintenanceRuns(robot);
		const run = await createMaintenanceRun(robot);
		return json({ data: run }, { status: 201 });
	} catch (e) {
		return json({ error: (e as Error).message }, { status: 502 });
	}
};

export const DELETE: RequestHandler = async ({ params, url, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	requirePermission(locals.user, 'manufacturing:write');

	const mrId = url.searchParams.get('id')?.trim();
	if (!mrId) return json({ error: 'Missing ?id=<maintenanceRunId>' }, { status: 400 });

	const robot = await getRobot(params.robotId as string);

	try {
		await endMaintenanceRun(robot, mrId);
		return json({ success: true });
	} catch (e) {
		return json({ error: (e as Error).message }, { status: 502 });
	}
};
