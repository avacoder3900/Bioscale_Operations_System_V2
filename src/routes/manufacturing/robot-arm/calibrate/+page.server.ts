/**
 * Robot Arm — Sync Zero Calibration.
 *
 * Captures a persistent matched reference pose for leader + follower.
 * Once captured, every teleop/record session starts from that calibrated
 * neutral instead of locking neutrals to whatever pose the arms are in
 * at GO time. The host side persists this to calibrations/sync_zero.json
 * on the Pi (arm-pi); nothing about it lives in MongoDB.
 *
 * Live deltas (current minus saved) are read on every page load so the
 * operator can verify alignment before pressing GO on the control page.
 */
import { fail, redirect } from '@sveltejs/kit';
import { connectDB, AuditLog, generateId } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import { robotArm } from '$lib/server/robot-arm-client';
import type { Actions, PageServerLoad } from './$types';

async function safeCalibration(live: boolean) {
	try {
		return await robotArm.getCalibration({ live });
	} catch (err) {
		return { error: (err as Error).message };
	}
}

async function safeActive() {
	try {
		const res = await robotArm.getActive();
		return res.active;
	} catch {
		return null;
	}
}

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');

	const active = await safeActive();
	// Skip live reads if a session is active — bus is single-owner and
	// the host will return live_error anyway. Saves a round-trip.
	const calibration = await safeCalibration(active === null);

	return { active, calibration };
};

export const actions: Actions = {
	capture: async ({ locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();
		try {
			const record = await robotArm.captureCalibration({
				triggered_by: { _id: locals.user._id, username: locals.user.username }
			});
			await AuditLog.create({
				_id: generateId(),
				action: 'robot_arm.calibrate.capture',
				resourceType: 'robot_arm_calibration',
				resourceId: 'sync_zero',
				userId: locals.user._id,
				username: locals.user.username,
				timestamp: new Date(),
				details: {
					captured_at: record.captured_at,
					leader_positions: record.leader_positions,
					follower_positions: record.follower_positions
				}
			});
			return { success: 'Sync zero captured.', capturedAt: record.captured_at };
		} catch (err) {
			return fail(500, { error: (err as Error).message });
		}
	},

	clear: async ({ locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();
		try {
			const res = await robotArm.clearCalibration();
			await AuditLog.create({
				_id: generateId(),
				action: 'robot_arm.calibrate.clear',
				resourceType: 'robot_arm_calibration',
				resourceId: 'sync_zero',
				userId: locals.user._id,
				username: locals.user.username,
				timestamp: new Date(),
				details: { removed: res.removed }
			});
			return res.removed
				? { success: 'Saved sync zero cleared. Teleop will lock neutrals at GO.' }
				: { success: 'No saved sync zero to clear.' };
		} catch (err) {
			return fail(500, { error: (err as Error).message });
		}
	}
};
