/**
 * Arm camera UVC controls (exposure, gain, white balance, ...), for the Vision
 * tab's camera settings panel.
 *
 *   GET  → { ...CameraControlsResponse, installed: boolean }
 *   POST { set: { name: value, ... }, persist?: true }   apply + remember
 *   POST { reset: true, persist?: true }                  camera defaults, forget saved
 *        → same shape, plus `applied` / `rejected` from the Pi
 *
 * The Pi side is services/robot-arm/src/server/camera_controls.py. Every
 * range the panel shows comes from the camera itself (v4l2-ctl), which is
 * also where the values are validated: this route only checks that the body
 * is well-formed (control names look like v4l2 names, values are whole
 * numbers or booleans) and leaves "is 4605 K a legal white balance" to the
 * device, which knows its own step.
 *
 * A Pi without camera_controls.py installed answers 404; that comes back as
 * `installed: false` with status 200 so the panel can say what to install
 * instead of showing an error. Writes need manufacturing:write and are
 * audit-logged: a camera left on a 1 s manual exposure is a dark, laggy
 * feed for the next operator, and the log says who set it and when.
 */
import { error, json } from '@sveltejs/kit';
import { connectDB, AuditLog, generateId } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import { robotArm, type CameraControlsResponse } from '$lib/server/robot-arm-client';
import type { RequestHandler } from './$types';
// Body parsing lives in ./body.ts: SvelteKit only allows request handlers
// (and `_`-prefixed names) as exports from a +server.ts, and the production
// build fails on anything else. The tests import the parser from there.
import { parseControlsBody } from './body';

function notInstalled(msg: string): boolean {
	return /robot-arm 404/.test(msg);
}

export const GET: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:read');
	const name = params.name;
	if (!name) error(400, 'Camera name required');
	const headers = { 'Cache-Control': 'no-store' };
	try {
		const r = await robotArm.getCameraControls(name);
		return json({ ...r, installed: true }, { headers });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (notInstalled(msg)) {
			return json(
				{ available: false, installed: false, reason: 'The Pi has no camera-controls route yet (services/robot-arm/scripts/install_vision_quality.py).', camera: name, device: null, controls: [], saved: {} },
				{ headers }
			);
		}
		// Status only: the upstream message can carry the Pi's base URL.
		console.error(`[arm-camera] controls "${name}" failed:`, msg);
		error(502, 'Camera controls unavailable');
	}
};

export const POST: RequestHandler = async ({ locals, params, request }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:write');
	const name = params.name;
	if (!name) error(400, 'Camera name required');
	const body = parseControlsBody(await request.json().catch(() => null));
	const headers = { 'Cache-Control': 'no-store' };

	let r: CameraControlsResponse;
	try {
		r = body.reset ? await robotArm.resetCameraControls(name, body.persist) : await robotArm.setCameraControls(name, body.set!, body.persist);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (notInstalled(msg)) {
			return json({ available: false, installed: false, reason: 'The Pi has no camera-controls route yet (services/robot-arm/scripts/install_vision_quality.py).', camera: name, device: null, controls: [], saved: {} }, { headers });
		}
		console.error(`[arm-camera] controls "${name}" write failed:`, msg);
		error(502, 'Camera controls unavailable');
	}

	try {
		await connectDB();
		await AuditLog.create({
			_id: generateId(),
			tableName: 'robot_arm_camera_controls',
			recordId: name,
			action: body.reset ? 'robot_arm.camera_controls.reset' : 'robot_arm.camera_controls.set',
			newData: {
				userId: locals.user._id,
				set: body.set ?? null,
				reset: !!body.reset,
				persist: body.persist,
				applied: r.applied ?? [],
				rejected: r.rejected ?? {},
				device: r.device
			},
			changedBy: locals.user.username,
			changedAt: new Date()
		});
	} catch (err) {
		console.warn('[arm-camera] controls change not audit-logged:', err instanceof Error ? err.message : err);
	}
	return json({ ...r, installed: true }, { headers });
};
