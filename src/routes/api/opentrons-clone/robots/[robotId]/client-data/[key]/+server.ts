/**
 * GET /api/opentrons-clone/robots/:robotId/client-data/:key
 * Pass-through to robot's /clientData/:key.
 */
import { error, json } from '@sveltejs/kit';
import { connectDB, OpentronsRobot } from '$lib/server/db';
import { robotBaseUrl } from '$lib/server/opentrons/client';
import { requirePermission } from '$lib/server/permissions';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();
	const robot = (await OpentronsRobot.findById(params.robotId)
		.select('_id ip port')
		.lean()) as { ip: string; port?: number } | null;
	if (!robot) throw error(404, 'Robot not found');

	try {
		const upstream = await fetch(
			`${robotBaseUrl(robot)}/clientData/${encodeURIComponent(params.key as string)}`,
			{ headers: { 'opentrons-version': '*' }, signal: AbortSignal.timeout(5_000) }
		);
		const body = await upstream.json().catch(() => null);
		return json(body ?? { error: 'no body' }, { status: upstream.status });
	} catch (e) {
		return json({ error: `Robot unreachable: ${(e as Error).message}` }, { status: 502 });
	}
};
