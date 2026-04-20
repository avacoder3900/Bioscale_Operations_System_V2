/**
 * POST /api/opentrons-clone/robots/:robotId/maintenance/:mrId/command
 *
 * Enqueues a single command on an existing maintenance run. The commandType
 * must be one of the allowlist used by the LPC wizard (home, loadPipette,
 * loadLabware, pickUpTip, moveToWell, moveRelative, savePosition, dropTip).
 *
 * The request body is the `*Create` payload directly, e.g.:
 *   { "commandType": "moveRelative",
 *     "params": { "pipetteId": "...", "axis": "z", "distance": 1 } }
 *
 * An optional `?timeoutMs=` query extends the robot-side wait beyond the
 * default 30 s. The robot's command response is returned verbatim so the
 * client can inspect `result` (savePosition coordinates, etc.).
 */
import { error, json } from '@sveltejs/kit';
import { connectDB, OpentronsRobot } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import {
	enqueueCommand,
	isAllowedCommandType,
	ALLOWED_COMMAND_TYPES,
	type MaintenanceCommand
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

export const POST: RequestHandler = async ({ params, url, request, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	requirePermission(locals.user, 'manufacturing:write');

	const mrId = params.mrId as string;
	if (!mrId) return json({ error: 'Missing maintenance run id' }, { status: 400 });

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Request body must be JSON' }, { status: 400 });
	}
	if (!body || typeof body !== 'object') {
		return json({ error: 'Request body must be a JSON object' }, { status: 400 });
	}

	const commandType = (body as { commandType?: unknown }).commandType;
	if (!isAllowedCommandType(commandType)) {
		return json(
			{ error: `commandType must be one of: ${ALLOWED_COMMAND_TYPES.join(', ')}` },
			{ status: 400 }
		);
	}

	const timeoutMsRaw = url.searchParams.get('timeoutMs');
	const timeoutMs = timeoutMsRaw ? parseInt(timeoutMsRaw, 10) : undefined;
	if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
		return json({ error: 'timeoutMs must be a positive integer' }, { status: 400 });
	}

	const robot = await getRobot(params.robotId as string);

	try {
		const result = await enqueueCommand(
			robot,
			mrId,
			body as MaintenanceCommand,
			timeoutMs ? { timeoutMs } : {}
		);
		return json({ data: result });
	} catch (e) {
		return json({ error: (e as Error).message }, { status: 502 });
	}
};
