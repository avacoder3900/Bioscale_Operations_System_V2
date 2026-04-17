/**
 * GET /api/opentrons-clone/robots/:robotId/data-files/:fileId/download
 * Pass-through stream from robot's /dataFiles/:id/download.
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

	const url = `${robotBaseUrl(robot)}/dataFiles/${encodeURIComponent(params.fileId as string)}/download`;
	let upstream: Response;
	try {
		upstream = await fetch(url, {
			headers: { 'opentrons-version': '*' },
			signal: AbortSignal.timeout(60_000)
		});
	} catch (e) {
		return json({ error: `Robot unreachable: ${(e as Error).message}` }, { status: 502 });
	}
	if (!upstream.ok) {
		return json({ error: 'Download failed', status: upstream.status }, { status: upstream.status });
	}
	const contentDisposition = upstream.headers.get('content-disposition') ?? `attachment; filename="${params.fileId}"`;
	return new Response(upstream.body, {
		status: 200,
		headers: {
			'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream',
			'Content-Disposition': contentDisposition,
			'Cache-Control': 'no-store'
		}
	});
};
