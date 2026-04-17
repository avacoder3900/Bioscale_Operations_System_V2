/**
 * GET /api/opentrons-clone/robots/:robotId/protocols/:protocolId/analysis/:analysisId/document
 * Streams the robot's analysis "asDocument" JSON back to the browser.
 * Pure pass-through — no DB, no caching.
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

	const url = `${robotBaseUrl(robot)}/protocols/${encodeURIComponent(
		params.protocolId as string
	)}/analyses/${encodeURIComponent(params.analysisId as string)}/asDocument`;

	let upstream: Response;
	try {
		upstream = await fetch(url, {
			headers: { 'opentrons-version': '*' },
			signal: AbortSignal.timeout(30_000)
		});
	} catch (e) {
		return json({ error: `Robot unreachable: ${(e as Error).message}` }, { status: 502 });
	}

	if (!upstream.ok) {
		return json(
			{ error: 'Analysis document fetch failed', status: upstream.status },
			{ status: upstream.status }
		);
	}

	const filename = `analysis-${params.analysisId}.json`;
	return new Response(upstream.body, {
		status: 200,
		headers: {
			'Content-Type': 'application/json',
			'Content-Disposition': `attachment; filename="${filename}"`,
			'Cache-Control': 'no-store'
		}
	});
};
