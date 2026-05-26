/**
 * Robot Arm — Cartesian Jog page.
 *
 * Reads current end-effector pose (mm) + joint state on load, and exposes
 * actions that map directly onto the FastAPI server's /jog/cartesian,
 * /torque, /jog/reload-calibration endpoints.
 *
 * Pose is also returned in load() so the page can render immediately;
 * actions return the post-jog pose so the UI can update without a polling
 * loop.
 */
import { fail, redirect } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection';
import { requirePermission } from '$lib/server/permissions';
import { robotArm } from '$lib/server/robot-arm-client';
import type { Actions, PageServerLoad } from './$types';

async function safePose() {
	try {
		return { pose: await robotArm.getPose(), error: null };
	} catch (err) {
		return { pose: null, error: (err as Error).message };
	}
}

async function safeActive() {
	try {
		return (await robotArm.getActive()).active;
	} catch {
		return null;
	}
}

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();

	const [poseResult, active] = await Promise.all([safePose(), safeActive()]);
	return { pose: poseResult.pose, poseError: poseResult.error, active };
};

export const actions: Actions = {
	jog: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		const data = await request.formData();
		const dx = parseFloat(data.get('dx_mm')?.toString() ?? '0');
		const dy = parseFloat(data.get('dy_mm')?.toString() ?? '0');
		const dz = parseFloat(data.get('dz_mm')?.toString() ?? '0');
		const cap = data.get('max_step_delta')?.toString();
		try {
			const result = await robotArm.jogCartesian({
				dx_mm: dx,
				dy_mm: dy,
				dz_mm: dz,
				...(cap ? { max_step_delta: parseInt(cap, 10) } : {})
			});
			const anyClamped = Object.values(result.clamped).some((n) => n > 0);
			const msg = anyClamped
				? `jogged (clamped at safe per-joint cap on ${Object.entries(result.clamped)
						.filter(([, n]) => n > 0)
						.map(([sid]) => `J${sid}`)
						.join(', ')})`
				: 'jogged';
			return { success: msg, pose: result.before, after: result.after_target, result };
		} catch (err) {
			const msg = (err as Error).message;
			const status = msg.includes('robot-arm 409') ? 409 : 502;
			return fail(status, { error: msg });
		}
	},

	torqueOn: async ({ locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		try {
			await robotArm.setTorque(true);
			return { success: 'torque enabled' };
		} catch (err) {
			return fail(502, { error: (err as Error).message });
		}
	},

	torqueOff: async ({ locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		try {
			await robotArm.setTorque(false);
			return { success: 'torque disabled (arm will sag under gravity)' };
		} catch (err) {
			return fail(502, { error: (err as Error).message });
		}
	},

	reloadCalibration: async ({ locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		try {
			const result = await robotArm.reloadJogCalibration();
			return { success: `calibration reloaded from ${result.calibration_source}` };
		} catch (err) {
			return fail(502, { error: (err as Error).message });
		}
	}
};
