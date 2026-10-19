/**
 * Robot Arm — Vision (ARM-04): sticker-marker calibration, live tracking,
 * and the camera-verified home check.
 *
 * Markers are the operator's own (registry below); a calibration is those
 * markers dragged onto a frozen camera frame with the arm parked at home.
 * Recalibrate whenever the camera moves or anything about the arm or its
 * surroundings changes. The live tracking itself runs in the browser on the
 * snapshot proxy; this file only persists and runs the server-side check.
 */
import { fail, redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { robotArm } from '$lib/server/robot-arm-client';
import { deriveArmHolder } from '$lib/server/robot-arm-lock';
import {
	checkHome,
	createMarker,
	listMarkers,
	loadCalibrations,
	retireCalibration,
	returnToHome,
	saveCalibration,
	setMarkerArchived,
	updateMarker,
	MAX_FRAME_BYTES,
	type PlacementInput
} from '$lib/server/robot-arm-vision';
import type { Actions, PageServerLoad } from './$types';

async function safeActive() {
	try {
		return { active: (await robotArm.getActive()).active, activeError: null };
	} catch (err) {
		return { active: null, activeError: (err as Error).message };
	}
}

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');

	const [markers, calibrations, activeResult, holder] = await Promise.all([
		listMarkers().catch(() => null),
		loadCalibrations().catch(() => null),
		safeActive(),
		deriveArmHolder().catch(() => null)
	]);

	return {
		markers: JSON.parse(JSON.stringify(markers ?? [])),
		markersError: markers ? null : 'Could not read the marker registry.',
		calibrations: JSON.parse(JSON.stringify(calibrations?.active ?? [])),
		history: JSON.parse(JSON.stringify(calibrations?.history ?? [])),
		calibrationsError: calibrations ? null : 'Could not read the calibrations.',
		active: activeResult.active,
		activeError: activeResult.activeError,
		holder: JSON.parse(JSON.stringify(holder ?? null))
	};
};

function who(locals: App.Locals) {
	return { _id: locals.user!._id, username: locals.user!.username };
}

function field(data: FormData, k: string): string | null {
	return data.get(k)?.toString() ?? null;
}

export const actions: Actions = {
	createMarker: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		const d = await request.formData();
		try {
			const m = await createMarker(who(locals), { name: field(d, 'name'), group: field(d, 'group'), color: field(d, 'color'), notes: field(d, 'notes') });
			return { success: `Marker "${m.name}" registered. Place it on the next calibration.`, scope: 'registry' };
		} catch (err) {
			return fail(400, { error: (err as Error).message, scope: 'registry' });
		}
	},

	updateMarker: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		const d = await request.formData();
		const id = field(d, 'id');
		if (!id) return fail(400, { error: 'Marker id missing.', scope: 'registry' });
		try {
			const m = await updateMarker(who(locals), id, { name: field(d, 'name'), group: field(d, 'group'), color: field(d, 'color'), notes: field(d, 'notes') });
			return { success: `Marker "${m.name}" updated. A calibration keeps the colour it sampled; recalibrate to pick up a new sticker.`, scope: 'registry' };
		} catch (err) {
			return fail(400, { error: (err as Error).message, scope: 'registry' });
		}
	},

	archiveMarker: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		const d = await request.formData();
		const id = field(d, 'id');
		const restore = field(d, 'restore') === '1';
		if (!id) return fail(400, { error: 'Marker id missing.', scope: 'registry' });
		try {
			await setMarkerArchived(who(locals), id, !restore);
			return { success: restore ? 'Marker restored.' : 'Marker archived. The active calibration still tracks it until you recalibrate.', scope: 'registry' };
		} catch (err) {
			return fail(400, { error: (err as Error).message, scope: 'registry' });
		}
	},

	// The browser sends the exact JPEG it froze plus the placements dragged
	// onto it. Saving supersedes the camera's previous active calibration.
	saveCalibration: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		const d = await request.formData();
		const cameraName = field(d, 'camera')?.trim() ?? '';
		const frame = d.get('frame');
		if (!(frame instanceof Blob) || frame.size === 0) return fail(400, { error: 'No calibration frame was sent — freeze a frame first.', scope: 'calibrate' });
		if (frame.size > MAX_FRAME_BYTES) return fail(413, { error: 'The calibration frame is too large.', scope: 'calibrate' });
		let placements: PlacementInput[];
		try {
			const raw = JSON.parse(field(d, 'placements') ?? '[]');
			if (!Array.isArray(raw)) throw new Error();
			placements = raw.map((p: any) => ({ markerId: String(p.markerId), x: Number(p.x), y: Number(p.y) }));
		} catch {
			return fail(400, { error: 'Placements could not be read.', scope: 'calibrate' });
		}
		const positionPx = Number(field(d, 'positionPx'));
		const frameWidth = Number(field(d, 'frameWidth'));
		try {
			const { summary, warnings } = await saveCalibration(who(locals), {
				cameraName,
				frame: Buffer.from(await frame.arrayBuffer()),
				placements,
				tolerances: {
					// Entered in pixels of the frame the operator is looking at; stored as a fraction of width.
					position: positionPx > 0 && frameWidth > 0 ? positionPx / frameWidth : null,
					depthMm: Number(field(d, 'depthMm')) || null
				},
				note: field(d, 'note')?.trim() || null
			});
			return {
				success: `Calibration saved for camera "${summary.cameraName}" with ${summary.placements.length} marker(s)${summary.depthAvailable ? ' and depth' : ''}.`,
				warnings,
				scope: 'calibrate'
			};
		} catch (err) {
			const msg = (err as Error).message;
			return fail(msg.includes('busy') ? 409 : 400, { error: `Calibration not saved: ${msg}`, scope: 'calibrate' });
		}
	},

	retireCalibration: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		const id = field(await request.formData(), 'id');
		if (!id) return fail(400, { error: 'Calibration id missing.', scope: 'home' });
		const done = await retireCalibration(who(locals), id);
		return { success: done ? 'Calibration retired. Home check is unavailable for that camera until you recalibrate.' : 'That calibration was already retired.', scope: 'home' };
	},

	// No motion.
	checkHome: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		const cameraName = field(await request.formData(), 'camera');
		try {
			const r = await checkHome(who(locals), { cameraName });
			return { ...(r.home.verdict === 'home' ? { success: r.message } : { warning: r.message }), homeResult: r, scope: 'home' };
		} catch (err) {
			return fail(502, { error: `Home check failed: ${(err as Error).message}`, scope: 'home' });
		}
	},

	// The arm MOVES: one bounded jog per joint to the calibrated encoder
	// steps, then encoders + markers verify. The Pi refuses while a session
	// holds the bus.
	returnHome: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		const cameraName = field(await request.formData(), 'camera');
		try {
			const r = await returnToHome(who(locals), { cameraName });
			return { ...(r.home.verdict === 'home' ? { success: r.message } : { warning: r.message }), homeResult: r, scope: 'home' };
		} catch (err) {
			const msg = (err as Error).message;
			const status = msg.includes('robot-arm 409') || msg.includes('busy') ? 409 : 502;
			return fail(status, { error: `Return to home failed: ${msg}`, scope: 'home' });
		}
	}
};
