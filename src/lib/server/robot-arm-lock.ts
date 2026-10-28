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
	/** Replay runs only: the loop the Pi is on, from its `replay.loop` events. Null for other kinds or before the first loop starts. */
	loop: ReplayLoop | null;
}

export interface ReplayLoop {
	/** 1-based loop currently playing. */
	index: number;
	/** Total loops requested. */
	of: number;
}

/** The shape of a run's events after the projection in deriveArmHolder — only what the loop needs. */
interface LoopEvent {
	type?: string;
	payload?: { index?: unknown; of?: unknown; loops?: unknown } | null;
}

/**
 * Current loop of a replay from its event timeline. The Pi logs
 * `replay.loop {index, of}` at the top of every loop (replay_settle.py),
 * so the last such event is the loop in progress. Before the first one lands
 * — the ramp to neutral, or a webhook still in flight — fall back to loop 1
 * of the `loops` the `replay.start` event announced, so the bar can still
 * say how many are coming. Null when neither is present (legacy runs).
 */
export function replayLoopFromEvents(events: LoopEvent[] | null | undefined): ReplayLoop | null {
	if (!Array.isArray(events)) return null;
	for (let i = events.length - 1; i >= 0; i--) {
		const e = events[i];
		if (e?.type !== 'replay.loop') continue;
		const index = Number(e.payload?.index);
		const of = Number(e.payload?.of);
		if (Number.isInteger(index) && index >= 1 && Number.isInteger(of) && of >= 1) {
			return { index, of: Math.max(of, index) };
		}
	}
	const start = events.find((e) => e?.type === 'replay.start');
	const loops = Number(start?.payload?.loops);
	if (Number.isInteger(loops) && loops >= 1) return { index: 1, of: loops };
	return null;
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

	// Loop progress is a second, replay-only read: the first query must stay
	// cheap (it runs on every arm page), and `events` carries the settle
	// payloads, so only the three fields the loop needs are projected.
	let loop: ReplayLoop | null = null;
	if (run.type === 'replay') {
		const withEvents = (await RobotArmRun.findById(run._id)
			.select('events.type events.payload.index events.payload.of events.payload.loops')
			.lean()) as { events?: LoopEvent[] } | null;
		loop = replayLoopFromEvents(withEvents?.events);
	}

	return {
		runId: run._id,
		type: run.type,
		username: run.triggeredBy?.username ?? null,
		userId: run.triggeredBy?._id ?? null,
		since: started ? new Date(started).toISOString() : null,
		stale: startedMs !== null && Date.now() - startedMs > ARM_RUN_STALE_MS,
		loop
	};
}
