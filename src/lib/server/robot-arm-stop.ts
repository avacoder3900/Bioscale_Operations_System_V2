/**
 * Stop whatever the arm is doing, from anywhere.
 *
 * One implementation behind the status card's "Stop arm" (POST
 * /api/robot-arm/stop) and the maintenance Control page's STOP bar, so the
 * two can never drift. ARM-01 §7.7: available to ANY manufacturing:write
 * user, including one who does not hold the arm — a stop that respects the
 * lock is a stop that fails when you need it most.
 *
 * Operator rule (2026-10-21): a cancelled run leaves the arm holding where
 * it is, never limp, so torque is turned back on right after the stop (one
 * retry: the Pi may still be releasing the session's bus).
 */
import { AuditLog, generateId } from '$lib/server/db';
import { robotArm } from '$lib/server/robot-arm-client';
import { deriveArmHolder } from '$lib/server/robot-arm-lock';

export interface StopArmResult {
	stoppedRunId: string | null;
	torqueOn: boolean;
	torqueError: string | null;
	/** Operator-facing one-liner. */
	message: string;
}

export async function stopArm(user: { _id: string; username: string }): Promise<StopArmResult> {
	// Read the holder before stopping so the audit trail names both parties.
	let heldBy: string | null = null;
	let heldRunId: string | null = null;
	try {
		const holder = await deriveArmHolder();
		heldBy = holder?.username ?? null;
		heldRunId = holder?.runId ?? null;
	} catch {
		// Best-effort attribution; never block a stop on it.
	}

	const result = await robotArm.stop();
	let torqueOn = false;
	let torqueError: string | null = null;
	for (let i = 0; i < 2 && !torqueOn; i++) {
		if (i) await new Promise((r) => setTimeout(r, 600));
		try {
			await robotArm.setTorque(true);
			torqueOn = true;
		} catch (e) {
			torqueError = (e as Error).message;
		}
	}
	await AuditLog.create({
		_id: generateId(),
		tableName: 'robot_arm_runs',
		recordId: result.stopped_run_id ?? heldRunId ?? 'none',
		action: 'robot_arm.session.stop',
		changedBy: user.username,
		newData: {
			userId: user._id,
			stopped_run_id: result.stopped_run_id ?? null,
			held_by: heldBy,
			stopped_by: user.username,
			override: heldBy !== null && heldBy !== user.username,
			torque_on: torqueOn,
			torque_error: torqueOn ? null : torqueError
		}
	});
	const stopped = `stop signal sent (${result.stopped_run_id ?? 'no active session'})`;
	return {
		stoppedRunId: result.stopped_run_id ?? null,
		torqueOn,
		torqueError: torqueOn ? null : torqueError,
		message: torqueOn
			? `${stopped}; torque re-enabled — the arm is holding its position.`
			: `${stopped}, but torque could NOT be re-enabled (${torqueError}) — the arm may be limp; enable torque before leaving it.`
	};
}
