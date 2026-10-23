/**
 * Arm depth stream mode (D415 Z16 at 480p = 848x480 or 720p = 1280x720), for
 * the Vision tab's depth panel.
 *
 *   GET  → { ...DepthConfig, installed: boolean }        does not start the stream
 *   POST { mode?: '480p' | '720p', fps?: 6 | 15 | 30, persist?: true }
 *        → same shape, `changed: true` when the Pi restarted its stream
 *
 * Pi side: depth.py GET/POST /depth/config (installed by
 * scripts/install_vision_quality.py; a Pi without it answers 404 →
 * `installed: false`, status 200). The status inside the answer carries the
 * measured frame rate and the v4l2-ctl reader's CPU, so the two modes can be
 * compared for cost on the live Pi; the Pi's temperature is on the camera
 * card chip (/api/robot-arm/thermal).
 *
 * Since 2026-10-23 this depth IS the tags' distance in every check, so the
 * mode is audit-logged like any other arm setting.
 */
import { error, json } from '@sveltejs/kit';
import { connectDB, AuditLog, generateId } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import { robotArm } from '$lib/server/robot-arm-client';
import type { RequestHandler } from './$types';
// Body parsing and the mode/fps tables live in ./body.ts: SvelteKit only
// allows request handlers (and `_`-prefixed names) as exports from a
// +server.ts, and the production build fails on anything else.
import { parseDepthConfigBody } from './body';

const NOT_INSTALLED = 'The Pi has no depth config route yet (services/robot-arm/scripts/install_vision_quality.py).';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:read');
	const headers = { 'Cache-Control': 'no-store' };
	try {
		const r = await robotArm.getDepthConfig();
		return json({ ...r, installed: true }, { headers });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (/robot-arm 404/.test(msg)) return json({ installed: false, reason: NOT_INSTALLED }, { headers });
		console.error('[arm-depth] config read failed:', msg);
		error(502, 'Depth config unavailable');
	}
};

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:write');
	const body = parseDepthConfigBody(await request.json().catch(() => null));
	const headers = { 'Cache-Control': 'no-store' };
	let r;
	try {
		r = await robotArm.setDepthConfig(body);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (/robot-arm 404/.test(msg)) return json({ installed: false, reason: NOT_INSTALLED }, { headers });
		console.error('[arm-depth] config write failed:', msg);
		error(502, 'Depth config unavailable');
	}
	try {
		await connectDB();
		await AuditLog.create({
			_id: generateId(),
			tableName: 'robot_arm_depth',
			recordId: 'stream',
			action: 'robot_arm.depth.config',
			newData: { userId: locals.user._id, requested: body, mode: r.mode, width: r.width, height: r.height, fps: r.fps, persisted: r.persisted, changed: !!r.changed },
			changedBy: locals.user.username,
			changedAt: new Date()
		});
	} catch (err) {
		console.warn('[arm-depth] config change not audit-logged:', err instanceof Error ? err.message : err);
	}
	return json({ ...r, installed: true }, { headers });
};
