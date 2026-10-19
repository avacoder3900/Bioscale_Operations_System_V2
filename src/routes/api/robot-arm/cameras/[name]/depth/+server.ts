/**
 * ARM-04 — depth (lidar) at points, proxied for the Vision tab's live view.
 *
 * Same reason the snapshot route exists: the browser only ever reaches BIMS,
 * never the Pi, and the API key stays on the server. The browser sends the
 * normalised positions it just tracked each marker to; this asks the Pi for
 * the depth there. Small and bounded: one short request per poll.
 */
import { error, json } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { robotArm } from '$lib/server/robot-arm-client';
import type { RequestHandler } from './$types';

/** More markers than any real setup; keeps a bad client from asking for an image's worth. */
const MAX_POINTS = 64;

export const POST: RequestHandler = async ({ locals, params, request }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:read');

	const body = await request.json().catch(() => null);
	const raw = Array.isArray(body?.points) ? body.points : null;
	if (!raw || raw.length > MAX_POINTS) error(400, `points must be an array of at most ${MAX_POINTS} [x, y] pairs`);
	const points: [number, number][] = [];
	for (const p of raw) {
		const x = Number(p?.[0]);
		const y = Number(p?.[1]);
		if (![x, y].every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) error(400, 'points are normalised [x, y] in 0..1');
		points.push([x, y]);
	}

	try {
		const s = await robotArm.sampleDepth(params.name, points);
		return json(
			{ available: s.available, depth_mm: s.depth_mm, reason: s.reason ?? null },
			{ headers: { 'Cache-Control': 'no-store' } }
		);
	} catch (err) {
		// Status only: the upstream message can carry the Pi's base URL.
		console.error(`[arm-camera] depth "${params.name}" failed:`, err instanceof Error ? err.message : err);
		error(502, 'Depth unavailable');
	}
};
