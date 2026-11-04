/**
 * Robot Arm — Vision (ARM-05): AprilTag calibration, live view, and the
 * camera-verified home check.
 *
 * Tags are the printed AprilTag 36h11 sheet, registered here by ID; a
 * calibration is one detection on the Pi with the arm parked at home.
 * Detection itself runs on the Pi (services/robot-arm/src/server/apriltags.py);
 * this file persists and runs the server-side check.
 */
import { fail, redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { robotArm } from '$lib/server/robot-arm-client';
import { deriveArmHolder } from '$lib/server/robot-arm-lock';
import {
	checkHome,
	closeClaw,
	createTag,
	listTags,
	loadCalibrations,
	requestHomeStop,
	retireCalibration,
	returnToHome,
	saveCalibration,
	setTagArchived,
	updateHoming,
	updateTag,
	type TagInput
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

	const [tags, calibrations, activeResult, holder] = await Promise.all([
		listTags().catch(() => null),
		loadCalibrations().catch(() => null),
		safeActive(),
		deriveArmHolder().catch(() => null)
	]);

	return {
		tags: JSON.parse(JSON.stringify(tags ?? [])),
		tagsError: tags ? null : 'Could not read the tag registry.',
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

function tagInput(d: FormData): TagInput {
	return {
		tagId: field(d, 'tagId'),
		sizeMm: field(d, 'sizeMm'),
		role: field(d, 'role'),
		name: field(d, 'name'),
		group: field(d, 'group'),
		notes: field(d, 'notes')
	};
}

export const actions: Actions = {
	createTag: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		try {
			const t = await createTag(who(locals), tagInput(await request.formData()));
			return { success: `Tag ${t.tagId} registered as "${t.name}" (${t.role}, ${t.sizeMm} mm). Recalibrate to include it.`, scope: 'registry' };
		} catch (err) {
			return fail(400, { error: (err as Error).message, scope: 'registry' });
		}
	},

	updateTag: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		const d = await request.formData();
		const id = field(d, 'id');
		if (!id) return fail(400, { error: 'Tag id missing.', scope: 'registry' });
		try {
			const t = await updateTag(who(locals), id, tagInput(d));
			return { success: `Tag ${t.tagId} updated. The active calibration keeps what it stored; recalibrate to pick up the change.`, scope: 'registry' };
		} catch (err) {
			return fail(400, { error: (err as Error).message, scope: 'registry' });
		}
	},

	archiveTag: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		const d = await request.formData();
		const id = field(d, 'id');
		const restore = field(d, 'restore') === '1';
		if (!id) return fail(400, { error: 'Tag id missing.', scope: 'registry' });
		try {
			await setTagArchived(who(locals), id, !restore);
			return { success: restore ? 'Tag restored.' : 'Tag archived. The active calibration still checks it until you recalibrate.', scope: 'registry' };
		} catch (err) {
			return fail(400, { error: (err as Error).message, scope: 'registry' });
		}
	},

	// One fresh detection on the Pi; every registered tag in view becomes home.
	// Saving supersedes the camera's previous active calibration.
	saveCalibration: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		const d = await request.formData();
		const num = (k: string) => {
			const v = field(d, k);
			return v == null || v === '' ? null : Number(v);
		};
		try {
			const { summary, warnings } = await saveCalibration(who(locals), {
				cameraName: field(d, 'camera')?.trim() ?? '',
				tolerances: { positionMm: num('positionMm'), angleDeg: num('angleDeg') },
				note: field(d, 'note')?.trim() || null
			});
			return {
				success: `Calibration saved for camera "${summary.cameraName}" with ${summary.tags.length} tag(s).`,
				warnings,
				scope: 'calibrate'
			};
		} catch (err) {
			const msg = (err as Error).message;
			return fail(msg.includes('busy') ? 409 : 400, { error: `Calibration not saved: ${msg}`, scope: 'calibrate' });
		}
	},

	// Servo 1's safe range (± degrees of home) and how far the mouth opens.
	updateHoming: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		const d = await request.formData();
		const id = field(d, 'id');
		if (!id) return fail(400, { error: 'Calibration id missing.', scope: 'home' });
		try {
			const h = await updateHoming(who(locals), id, {
				baseRangeDeg: Number(field(d, 'baseRangeDeg')),
				gripperOpenSteps: Number(field(d, 'gripperOpenSteps'))
			});
			return { success: `Home settings saved: servo 1 range ±${Math.round((h.baseRangeSteps * 360) / 4096)}°, mouth opens ${h.gripperOpenSteps} steps.`, scope: 'home' };
		} catch (err) {
			return fail(400, { error: (err as Error).message, scope: 'home' });
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
	// steps, then encoders + tags verify. The Pi refuses while a session
	// holds the bus.
	// Stop returning: the attempt in progress ends before its next jog; the
	// Vision tab then closes the mouth.
	stopReturn: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		const d = await request.formData();
		try {
			await requestHomeStop(who(locals), { cameraName: field(d, 'camera'), runId: field(d, 'runId') ?? '' });
			return { stopRequested: true, scope: 'home' };
		} catch (err) {
			return fail(400, { error: (err as Error).message, scope: 'home' });
		}
	},

	// Final step of every Return to home: close the claw (the arm MOVES —
	// servo 6 only). The Vision tab calls this when its loop ends with the
	// claw still open, and repeats it until closed.
	closeClaw: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		const cameraName = field(await request.formData(), 'camera');
		try {
			const r = await closeClaw(who(locals), { cameraName });
			return { clawResult: r, scope: 'home' };
		} catch (err) {
			const msg = (err as Error).message;
			return fail(msg.includes('robot-arm 409') || msg.includes('busy') ? 409 : 502, { error: `Closing the claw failed: ${msg}`, scope: 'home' });
		}
	},

	returnHome: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		const d = await request.formData();
		const cameraName = field(d, 'camera');
		// The Vision tab repeats this action until home (≤ 90 s); only attempt 1 opens the mouth.
		const attempt = Number(field(d, 'attempt')) || 1;
		const runId = field(d, 'runId');
		try {
			const r = await returnToHome(who(locals), { cameraName, attempt, runId });
			return { ...(r.home.verdict === 'home' ? { success: r.message } : { warning: r.message }), homeResult: r, scope: 'home' };
		} catch (err) {
			const msg = (err as Error).message;
			const status = msg.includes('robot-arm 409') || msg.includes('busy') ? 409 : 502;
			return fail(status, { error: `Return to home failed: ${msg}`, scope: 'home' });
		}
	}
};
