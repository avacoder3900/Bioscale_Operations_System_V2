/**
 * GET /api/opentrons-clone/robots/:robotId/logs/:logId
 * Pass-through to robot's /logs/:log_identifier.
 * Valid logId values (per spec 8.7.0): api.log, server.log, serial.log, update_server.log
 */
import { error, json } from '@sveltejs/kit';
import { connectDB, OpentronsRobot } from '$lib/server/db';
import { robotBaseUrl } from '$lib/server/opentrons/client';
import { requirePermission } from '$lib/server/permissions';
import type { RequestHandler } from './$types';

const ALLOWED = new Set(['api.log', 'server.log', 'serial.log', 'update_server.log']);

export const GET: RequestHandler = async ({ params, url, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	requirePermission(locals.user, 'manufacturing:read');

	const logId = params.logId as string;
	if (!ALLOWED.has(logId)) {
		return json({ error: `Invalid log id. Allowed: ${[...ALLOWED].join(', ')}` }, { status: 400 });
	}

	await connectDB();
	const robot = (await OpentronsRobot.findById(params.robotId)
		.select('_id ip port')
		.lean()) as { ip: string; port?: number } | null;
	if (!robot) throw error(404, 'Robot not found');

	const records = url.searchParams.get('records') ?? '5000';
	const qs = new URLSearchParams({ records });
	const upstreamUrl = `${robotBaseUrl(robot)}/logs/${encodeURIComponent(logId)}?${qs}`;

	let upstream: Response;
	try {
		upstream = await fetch(upstreamUrl, {
			headers: { 'opentrons-version': '*' },
			signal: AbortSignal.timeout(60_000)
		});
	} catch (e) {
		return json({ error: `Robot unreachable: ${(e as Error).message}` }, { status: 502 });
	}
	if (!upstream.ok) {
		return json({ error: 'Log fetch failed', status: upstream.status }, { status: upstream.status });
	}
	return new Response(upstream.body, {
		status: 200,
		headers: {
			'Content-Type': 'text/plain; charset=utf-8',
			'Content-Disposition': `attachment; filename="${logId}"`,
			'Cache-Control': 'no-store'
		}
	});
};
