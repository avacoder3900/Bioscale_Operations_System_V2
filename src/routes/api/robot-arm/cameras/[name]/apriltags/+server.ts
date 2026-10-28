/**
 * ARM-05 — AprilTags in the camera's current frame, for the Vision tab.
 *
 * The browser never reaches the Pi and the API key stays on the server, so
 * the live view and the calibration preview both come through here. One
 * detection per request; the JPEG the tags were found in comes back with
 * them, so the outlines are drawn on exactly the picture they belong to.
 *
 * `?frames=N` (1..10) asks the Pi to average each tag's corners over N
 * distinct captures; each tag then carries `jitterPx` and `framesSeen`.
 * `?average=N` (1..60) asks it to stack N consecutive frames pixel by pixel
 * into each image before detecting (2026-10-28); `framesAveraged`,
 * `captureMs` and `motionLuma` come back with the answer.
 */
import { error, json } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { detectTags } from '$lib/server/robot-arm-vision';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, params, url }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:read');
	const framesRaw = Number(url.searchParams.get('frames') ?? 1);
	const frames = Number.isFinite(framesRaw) ? Math.max(1, Math.min(10, Math.round(framesRaw))) : 1;
	const averageRaw = Number(url.searchParams.get('average') ?? 1);
	const average = Number.isFinite(averageRaw) ? Math.max(1, Math.min(60, Math.round(averageRaw))) : 1;

	try {
		const r = await detectTags(params.name, { includeFrame: true, frames, average });
		return json(
			{
				available: r.available,
				reason: r.reason,
				detector: r.detector,
				width: r.width,
				height: r.height,
				intrinsics: r.intrinsics,
				tags: r.tags,
				frameSource: r.frameSource,
				framesUsed: r.framesUsed,
				framesAveraged: r.framesAveraged,
				captureMs: r.captureMs,
				motionLuma: r.motionLuma,
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
