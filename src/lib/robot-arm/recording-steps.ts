/**
 * Recording clean-up: turn a raw leader-follower recording into numbered steps.
 *
 * A recording is a JSONL stream of frames, `{ t: seconds, positions: { sid: steps } }`,
 * captured at the record rate (30 Hz by default). Every wobble of the leader arm
 * is in there.
 *
 * This module deliberately does NOT smooth, filter or drop anything. It only
 * *labels* the raw data:
 *
 *   1. Moves, per servo. A servo is "moving" while its raw position keeps
 *      changing by more than `thresholdSteps` from where it last settled. The
 *      operator sets the threshold; 0 means every change counts. Consecutive
 *      changes in the same direction, no more than `pauseS` apart, are one move.
 *      A reversal always starts a new move.
 *   2. Steps. Moves that overlap in time are grouped into one numbered step, with
 *      at most one move per servo per step (a servo moving again starts the next
 *      step).
 *
 * Each move keeps the raw recorded positions at its start and end. What to delete
 * and how far each servo should really move is the operator's decision, made in
 * the editor, not here.
 */

export type ServoId = number;

export interface RecordingFrame {
	t: number;
	positions: Record<string, number>;
}

export interface Move {
	servoId: ServoId;
	/** Raw recorded position at the frame the move started from. */
	from: number;
	/** Raw recorded position at the frame the move ended on. */
	to: number;
	tStart: number;
	tEnd: number;
	/** Frame indices into the recording, inclusive. */
	startFrame: number;
	endFrame: number;
}

export interface Step {
	/** 1-based, in time order. */
	number: number;
	tStart: number;
	tEnd: number;
	/** At most one per servo, sorted by servo id. */
	moves: Move[];
}

export interface StepOptions {
	/** A change smaller than or equal to this (in servo steps) is not a move. 0 = every change. */
	thresholdSteps: number;
	/** Gap (seconds) of no change that ends a move. */
	pauseS?: number;
}

export interface StepResult {
	servoIds: ServoId[];
	/** Raw positions at the first frame. */
	initial: Record<ServoId, number>;
	steps: Step[];
	durationS: number;
	frameCount: number;
}

export const DEFAULT_PAUSE_S = 0.25;
/** STS3215: 4096 steps per revolution. */
export const STEPS_PER_DEGREE = 4096 / 360;

export interface RecordingHeader {
	version?: string;
	rateHz?: number;
	/** Index i names servo id i + 1. */
	jointNames?: string[];
	/** The header line exactly as recorded (neutrals, limits, scale, …). */
	raw?: Record<string, unknown>;
}

export interface ParsedRecording {
	header: RecordingHeader | null;
	frames: RecordingFrame[];
}

/**
 * Parse a recording as the live Pi writes it (hardware/dual_arm.py, version 1):
 *
 *   {"event":"header", "rate_hz":30, "joint_names":[...6], ...}
 *   {"event":"frame", "t":0.0186, "leader":[6], "follower":[6], "goal":[6]}
 *   {"event":"footer", "duration_s":83.2, "frames":2490}
 *
 * Steps are built from `goal`, because that array is what replay sends to the
 * follower (dual_arm.py iterates frame["goal"]). Array index i is servo id i + 1.
 * The older `{t, positions: {sid: pos}}` line format is still accepted.
 */
export function parseRecording(jsonl: string): ParsedRecording {
	let header: RecordingHeader | null = null;
	const frames: RecordingFrame[] = [];
	for (const line of jsonl.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const rec = JSON.parse(line) as Record<string, unknown>;
		if (rec.event === 'header') {
			header = {
				version: typeof rec.version === 'string' ? rec.version : undefined,
				rateHz: typeof rec.rate_hz === 'number' ? rec.rate_hz : undefined,
				jointNames: Array.isArray(rec.joint_names) ? rec.joint_names.map(String) : undefined,
				raw: rec
			};
			continue;
		}
		if (rec.event !== undefined && rec.event !== 'frame') continue;
		if (typeof rec.t !== 'number') throw new Error('recording frame has no numeric t');
		if (Array.isArray(rec.goal)) {
			const positions: Record<string, number> = {};
			rec.goal.forEach((p, i) => {
				if (typeof p === 'number') positions[String(i + 1)] = p;
			});
			frames.push({ t: rec.t, positions });
		} else if (rec.positions && typeof rec.positions === 'object') {
			frames.push({ t: rec.t, positions: rec.positions as Record<string, number> });
		} else {
			throw new Error('recording frame has neither goal[] nor positions{}');
		}
	}
	return { header, frames };
}

/**
 * Where a move really began: walk back from the frame that crossed the threshold
 * through the unbroken run of frames heading the same way, but not past the
 * anchor. Flat stretches shorter than `pauseS` are crossed (commanded positions
 * plateau mid-move); a longer one is a hold and ends the walk, the same rule
 * that ends a move. Then skip forward over a flat lead-in, so the move starts
 * on the last frame before the position changed. A slow sweep (each frame under
 * the threshold) therefore starts where it left the hold, not at the frame that
 * finally crossed.
 */
function runStart(
	frames: RecordingFrame[],
	key: string,
	anchorIdx: number,
	crossIdx: number,
	dir: number,
	pauseS: number
): number {
	let start = crossIdx;
	let flatSince: number | null = null;
	for (let j = crossIdx - 1; j >= anchorIdx; j--) {
		const prev = frames[j].positions[key];
		const next = frames[j + 1].positions[key];
		if (typeof prev !== 'number' || typeof next !== 'number') break;
		const step = Math.sign(next - prev);
		if (step === -dir) break;
		if (step === 0) {
			flatSince ??= frames[j + 1].t;
			if (flatSince - frames[j].t > pauseS) break;
		} else {
			flatSince = null;
		}
		start = j;
	}
	while (start < crossIdx && frames[start + 1].positions[key] === frames[start].positions[key]) start++;
	return start;
}

/** Moves for one servo, in time order. */
export function detectMoves(
	frames: RecordingFrame[],
	servoId: ServoId,
	opts: StepOptions
): Move[] {
	const threshold = Math.max(0, opts.thresholdSteps);
	const pauseS = opts.pauseS ?? DEFAULT_PAUSE_S;
	const key = String(servoId);
	const moves: Move[] = [];

	// `anchor` is where the servo last settled (or the last position that crossed
	// the threshold). A change event is a frame whose raw position differs from the
	// anchor by more than the threshold; the event then becomes the new anchor.
	let anchorIdx = -1;
	let current: (Move & { dir: number; lastEventT: number }) | null = null;

	const finish = () => {
		if (current) {
			const { dir: _dir, lastEventT: _last, ...move } = current;
			moves.push(move);
			current = null;
		}
	};

	for (let i = 0; i < frames.length; i++) {
		const pos = frames[i].positions[key];
		if (typeof pos !== 'number') continue;
		if (anchorIdx < 0) {
			anchorIdx = i;
			continue;
		}
		const anchorPos = frames[anchorIdx].positions[key];
		const delta = pos - anchorPos;
		if (Math.abs(delta) <= threshold) continue;

		const dir = Math.sign(delta);
		const t = frames[i].t;
		const continues = current !== null && current.dir === dir && t - current.lastEventT <= pauseS;
		if (!continues) {
			finish();
			const startIdx = runStart(frames, key, anchorIdx, i, dir, pauseS);
			current = {
				servoId,
				from: frames[startIdx].positions[key],
				to: pos,
				tStart: frames[startIdx].t,
				tEnd: t,
				startFrame: startIdx,
				endFrame: i,
				dir,
				lastEventT: t
			};
		} else if (current) {
			current.to = pos;
			current.tEnd = t;
			current.endFrame = i;
			current.lastEventT = t;
		}
		anchorIdx = i;
	}
	finish();
	return moves;
}

/** Group overlapping moves (across servos) into numbered steps, one move per servo per step. */
export function groupIntoSteps(moves: Move[]): Step[] {
	const sorted = [...moves].sort((a, b) => a.tStart - b.tStart || a.servoId - b.servoId);
	const steps: Step[] = [];
	let group: Move[] = [];
	let groupEnd = -Infinity;

	const close = () => {
		if (!group.length) return;
		steps.push({
			number: steps.length + 1,
			tStart: Math.min(...group.map((m) => m.tStart)),
			tEnd: Math.max(...group.map((m) => m.tEnd)),
			moves: [...group].sort((a, b) => a.servoId - b.servoId)
		});
		group = [];
		groupEnd = -Infinity;
	};

	for (const m of sorted) {
		// A move that starts exactly when the group ends is sequential, not overlapping.
		const overlaps = m.tStart < groupEnd;
		const servoTaken = group.some((g) => g.servoId === m.servoId);
		if (!overlaps || servoTaken) close();
		group.push(m);
		groupEnd = Math.max(groupEnd, m.tEnd);
	}
	close();
	return steps;
}

export function recordingToSteps(frames: RecordingFrame[], opts: StepOptions): StepResult {
	const ids = new Set<ServoId>();
	for (const f of frames) for (const k of Object.keys(f.positions)) ids.add(Number(k));
	const servoIds = [...ids].filter(Number.isFinite).sort((a, b) => a - b);

	const initial: Record<ServoId, number> = {};
	for (const sid of servoIds) {
		const first = frames.find((f) => typeof f.positions[String(sid)] === 'number');
		if (first) initial[sid] = first.positions[String(sid)];
	}

	const moves = servoIds.flatMap((sid) => detectMoves(frames, sid, opts));
	return {
		servoIds,
		initial,
		steps: groupIntoSteps(moves),
		durationS: frames.length ? frames[frames.length - 1].t - frames[0].t : 0,
		frameCount: frames.length
	};
}
