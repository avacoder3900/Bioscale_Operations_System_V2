/**
 * Robot Arm — Sync Zero Calibration.
 *
 * Captures a persistent matched reference pose for leader + follower.
 * Once captured, every teleop/record session starts from that calibrated
 * neutral instead of locking neutrals to whatever pose the arms are in
 * at GO time. The host side persists this to calibrations/sync_zero.json
 * on alejandros-pc; nothing about it lives in MongoDB.
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

async function safeJointMap(live: boolean) {
	try {
		return await robotArm.getJointMap({ live });
	} catch (err) {
		return { map: null, live: null, live_error: (err as Error).message };
	}
}

/**
 * `reachable` distinguishes "the host answered, nothing is running" from
 * "we could not ask". Both used to collapse to null, which made an
 * unreachable Pi look like an idle one and sent the load down the most
 * expensive path — two live reads that can only ever time out.
 */
async function safeActive() {
	try {
		const res = await robotArm.getActive();
		return { active: res.active, reachable: true };
	} catch {
		return { active: null, reachable: false };
	}
}

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');

	const { active, reachable } = await safeActive();
	// Skip live reads if a session is active — bus is single-owner and the
	// host will return live_error anyway — and also if the host never
	// answered at all, since a live read would just burn its whole timeout.
	// Worst case is then 5s + 10s + 10s = 25s, inside the adapter's
	// maxDuration of 30 (svelte.config.js).
	const live = reachable && active === null;
	// Sequential, not Promise.all: both live reads open the same two serial
	// buses, and the Pi serialises them anyway. Firing them together just
	// makes one fail with a port-busy error.
	const calibration = await safeCalibration(live);
	const jointMap = await safeJointMap(live);

	return { active, reachable, calibration, jointMap };
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
	},

	// --- multi-pose joint map ---

	capturePose: async ({ locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();
		try {
			const map = await robotArm.capturePose({
				triggered_by: { _id: locals.user._id, username: locals.user.username }
			});
			// Field names must match auditLogSchema (tableName/recordId/
			// changedBy/changedAt/newData). Mongoose strict mode silently
			// DROPS unknown paths on create, so a resourceType/userId/details
			// shape persists as {_id, action, changedAt} — an audit row that
			// looks written but records nothing.
			await AuditLog.create({
				_id: generateId(),
				tableName: 'robot_arm_calibration',
				recordId: 'joint_map',
				action: 'robot_arm.calibrate.capture_pose',
				changedBy: locals.user.username,
				changedAt: new Date(),
				newData: {
					n_poses: map.fit.n_poses,
					fitted_at: map.fit.fitted_at,
					scale: map.fit.scale,
					offset: map.fit.offset,
					status: map.fit.status
				}
			});
			return { success: `Pose ${map.fit.n_poses} captured.`, nPoses: map.fit.n_poses };
		} catch (err) {
			return fail(500, { error: (err as Error).message });
		}
	},

	deletePose: async ({ locals, request }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();

		const data = await request.formData();
		// Trim before testing: Number('   ') is 0, which would pass the
		// integer check and silently delete pose 0.
		const raw = data.get('index')?.toString().trim();
		const index = Number(raw);
		if (!raw || !Number.isInteger(index) || index < 0) {
			return fail(400, { error: 'A valid pose index is required.' });
		}

		try {
			const map = await robotArm.deletePose(index);
			await AuditLog.create({
				_id: generateId(),
				tableName: 'robot_arm_calibration',
				recordId: 'joint_map',
				action: 'robot_arm.calibrate.delete_pose',
				changedBy: locals.user.username,
				changedAt: new Date(),
				newData: {
					deleted_index: index,
					n_poses: map.fit.n_poses,
					status: map.fit.status
				}
			});
			return { success: `Pose ${index} deleted. Refitted on ${map.fit.n_poses} pose(s).` };
		} catch (err) {
			return fail(500, { error: (err as Error).message });
		}
	},

	clearMap: async ({ locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();
		try {
			const res = await robotArm.clearJointMap();
			await AuditLog.create({
				_id: generateId(),
				tableName: 'robot_arm_calibration',
				recordId: 'joint_map',
				action: 'robot_arm.calibrate.clear_map',
				changedBy: locals.user.username,
				changedAt: new Date(),
				newData: { removed: res.removed }
			});
			return res.removed
				? { success: 'Joint map cleared. Teleop reverts to a 1:1 mirror.' }
				: { success: 'No saved joint map to clear.' };
		} catch (err) {
			return fail(500, { error: (err as Error).message });
		}
	}
};
