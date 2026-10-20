/**
 * ARM-05 — AprilTags in the camera's current frame, for the Vision tab.
 *
 * The browser never reaches the Pi and the API key stays on the server, so
 * the live view and the calibration preview both come through here. One
 * detection per request; the JPEG the tags were found in comes back with
 * them, so the outlines are drawn on exactly the picture they belong to.
 */
import { error, json } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { detectTags } from '$lib/server/robot-arm-vision';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:read');

	try {
		const r = await detectTags(params.name, { includeFrame: true });
		return json(
			{
				available: r.available,
				reason: r.reason,
				detector: r.detector,
				width: r.width,
				height: r.height,
				intrinsics: r.intrinsics,
				tags: r.tags,
				frame: r.frame ? `data:image/jpeg;base64,${r.frame.toString('base64')}` : null
			},
			{ headers: { 'Cache-Control': 'no-store' } }
		);
	} catch (err) {
		// Status only: the upstream message can carry the Pi's base URL.
		console.error(`[arm-camera] apriltags "${params.name}" failed:`, err instanceof Error ? err.message : err);
		error(502, 'Tag detection unavailable');
	}
};
