// Who currently holds the robot arm — DERIVED, never stored.
//
// Per docs/prds/ARM-01-pi-connection-and-task-control.md §7.7. Because the arm
// is controllable from any device (G0), two operators can now issue commands at
// the same moment. This module answers "who has it right now" for the control
// bar.
//
// There is deliberately no lock field, no lock collection, and no write path.
// The arm is held iff a RobotArmRun exists that hasn't reached a terminal
// state; the holder is that run's existing `triggeredBy`. A stored lock would
// be a second source of truth that can disagree with the run log —
// capture_stations.currentOperator is the cautionary tale in this codebase: it
// has no expiry and has to be cleared out of Mongo by hand. A derived lock
// can't drift, needs no release path (the terminal webhook event that
// finalizes the run IS the release), and can't strand the arm.
//
// This is advisory. The Pi is the authority on whether the serial bus is free
// and returns 409 from _start_or_409 / _require_bus_free if it isn't.

import { RobotArmRun } from '$lib/server/db/models';

// Mirrors STALE_THRESHOLD_MS in capture-station.ts rather than inventing a
// second expiry rule — but an arm run is a long-lived operation, not a 30s
// heartbeat, so the window is correspondingly wider. A non-terminal run older
// than this is reported as abandoned rather than silently trusted.
export const ARM_RUN_STALE_MS = 30 * 60 * 1000; // 30 minutes

export interface ArmHolder {
	runId: string;
	type: string;
	username: string | null;
	userId: string | null;
	since: string | null;
	/** Non-terminal but older than ARM_RUN_STALE_MS — almost certainly abandoned. */
	stale: boolean;
}

/**
 * The current holder of the arm, or null if it's free.
 *
 * Covered by the existing { status, createdAt: -1 } index on robot_arm_runs.
 */
export async function deriveArmHolder(): Promise<ArmHolder | null> {
	const run = await RobotArmRun.findOne({
		status: { $in: ['pending', 'running'] },
		finalizedAt: { $in: [null, undefined] }
	})
		.select('_id runId type status triggeredBy startedAt createdAt')
		.sort({ createdAt: -1 })
		.lean();

	if (!run) return null;

	const started = run.startedAt ?? run.createdAt ?? null;
	const startedMs = started ? new Date(started).getTime() : null;

	return {
		runId: run._id,
		type: run.type,
		username: run.triggeredBy?.username ?? null,
		userId: run.triggeredBy?._id ?? null,
		since: started ? new Date(started).toISOString() : null,
		stale: startedMs !== null && Date.now() - startedMs > ARM_RUN_STALE_MS
	};
}
