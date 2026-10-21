/**
 * Recording clean-up: the operator's edited version of a recording, and the
 * replayable recording it turns into.
 *
 * recording-steps.ts only labels raw data. Everything here is the operator's:
 * which moves stay, where each servo ends up, how long each step takes. The
 * only thing this module decides is how a step is played back: every servo in
 * the step moves together, in a straight line from where it was to its target,
 * over the step's duration. Nothing is smoothed or dropped on the way.
 */
import {
	type RecordingHeader,
	type ServoId,
	type StepResult
} from './recording-steps';

export const SERVO_IDS: ServoId[] = [1, 2, 3, 4, 5, 6];
export const DEFAULT_JOINT_NAMES = [
	'shoulder_pan',
	'shoulder_lift',
	'elbow_flex',
	'wrist_flex',
	'wrist_roll',
	'gripper'
];
export const MIN_STEP_S = 0.1;
export const MAX_STEP_S = 120;
export const MAX_STEPS = 500;
const ENCODER_MAX = 4095;

export interface CleanMove {
	servoId: ServoId;
	/** Where the operator wants this servo at the end of the step (raw encoder steps). */
	to: number;
	/** What the recording did, for reference. Null for a move the operator added. */
	raw: { from: number; to: number } | null;
}

export interface CleanStep {
	/** Stable id for the editor (keys, selection). */
	id: string;
	label: string;
	durationS: number;
	pauseAfterS: number;
	/** Raw time span this step came from. Null for a step the operator added. */
	raw: { tStart: number; tEnd: number } | null;
	moves: CleanMove[];
}

export interface CleanDraft {
	/** Pose the replay starts from (replay ramps the follower here first). */
	start: Record<string, number>;
	steps: CleanStep[];
}

export function joints(header: RecordingHeader | null | undefined): string[] {
	const names = header?.jointNames;
	return SERVO_IDS.map((sid) => names?.[sid - 1] ?? DEFAULT_JOINT_NAMES[sid - 1]);
}

export function roundTenth(n: number): number {
	return Math.round(n * 10) / 10;
}

let idCounter = 0;
export function newStepId(): string {
	idCounter += 1;
	return `s${Date.now().toString(36)}${idCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * First draft from the detected steps: raw targets, raw durations, and the
 * recorded idle time before the next step as each step's pause, so playback
 * keeps the recording's timing until the operator changes it.
 */
export function draftFromSteps(result: StepResult): CleanDraft {
	const start: Record<string, number> = {};
	for (const sid of result.servoIds) {
		if (Number.isFinite(result.initial[sid])) start[String(sid)] = result.initial[sid];
	}
	const steps: CleanStep[] = result.steps.map((s, i) => ({
		id: newStepId(),
		label: '',
		durationS: Math.max(MIN_STEP_S, roundTenth(s.tEnd - s.tStart)),
		pauseAfterS: Math.min(MAX_STEP_S, Math.max(0, roundTenth((result.steps[i + 1]?.tStart ?? s.tEnd) - s.tEnd))),
		raw: { tStart: s.tStart, tEnd: s.tEnd },
		moves: s.moves.map((m) => ({ servoId: m.servoId, to: m.to, raw: { from: m.from, to: m.to } }))
	}));
	return { start, steps };
}

export interface ResolvedMove extends CleanMove {
	from: number;
	delta: number;
}

export interface ResolvedStep {
	step: CleanStep;
	number: number;
	moves: ResolvedMove[];
	/** Pose before / after the step, every servo. */
	before: Record<string, number>;
	after: Record<string, number>;
	/** Playback time the step starts at, seconds from the start of the replay. */
	tStart: number;
}

/**
 * Chain the steps: each move starts wherever its servo was left by the steps
 * before it. A servo that is not in a step holds.
 */
export function resolveSteps(draft: CleanDraft): { steps: ResolvedStep[]; durationS: number; end: Record<string, number> } {
	let pose: Record<string, number> = { ...draft.start };
	let t = 0;
	const steps: ResolvedStep[] = draft.steps.map((step, i) => {
		const before = pose;
		const after = { ...pose };
		const moves = step.moves.map((m) => {
			const key = String(m.servoId);
			const from = before[key] ?? m.raw?.from ?? m.to;
			after[key] = m.to;
			return { ...m, from, delta: m.to - from };
		});
		const out: ResolvedStep = { step, number: i + 1, moves, before, after, tStart: t };
		pose = after;
		t += step.durationS + step.pauseAfterS;
		return out;
	});
	return { steps, durationS: t, end: pose };
}

/** Throws with an operator-readable message when the draft cannot be saved. */
export function validateDraft(draft: unknown): CleanDraft {
	if (!draft || typeof draft !== 'object') throw new Error('draft is missing');
	const d = draft as { start?: unknown; steps?: unknown };
	const start: Record<string, number> = {};
	if (!d.start || typeof d.start !== 'object') throw new Error('start pose is missing');
	for (const [k, v] of Object.entries(d.start as Record<string, unknown>)) {
		const sid = Number(k);
		if (!SERVO_IDS.includes(sid)) throw new Error(`start pose has unknown servo ${k}`);
		start[String(sid)] = encoder(v, `start pose servo ${sid}`);
	}
	if (!Array.isArray(d.steps)) throw new Error('steps are missing');
	if (d.steps.length > MAX_STEPS) throw new Error(`at most ${MAX_STEPS} steps`);
	const seenIds = new Set<string>();
	const steps = d.steps.map((raw, i): CleanStep => {
		const n = i + 1;
		if (!raw || typeof raw !== 'object') throw new Error(`step ${n} is not an object`);
		const s = raw as Record<string, unknown>;
		let id = typeof s.id === 'string' && s.id.length <= 64 && s.id ? s.id : newStepId();
		if (seenIds.has(id)) id = newStepId();
		seenIds.add(id);
		const durationS = Number(s.durationS);
		if (!Number.isFinite(durationS) || durationS < MIN_STEP_S || durationS > MAX_STEP_S) {
			throw new Error(`step ${n}: duration must be ${MIN_STEP_S}–${MAX_STEP_S} s`);
		}
		const pauseAfterS = Number(s.pauseAfterS ?? 0);
		if (!Number.isFinite(pauseAfterS) || pauseAfterS < 0 || pauseAfterS > MAX_STEP_S) {
			throw new Error(`step ${n}: pause must be 0–${MAX_STEP_S} s`);
		}
		const rawSpan = s.raw as { tStart?: unknown; tEnd?: unknown } | null | undefined;
		const span =
			rawSpan && Number.isFinite(Number(rawSpan.tStart)) && Number.isFinite(Number(rawSpan.tEnd))
				? { tStart: Number(rawSpan.tStart), tEnd: Number(rawSpan.tEnd) }
				: null;
		if (!Array.isArray(s.moves)) throw new Error(`step ${n}: moves are missing`);
		const servos = new Set<number>();
		const moves = s.moves.map((mv): CleanMove => {
			const m = mv as Record<string, unknown>;
			const servoId = Number(m.servoId);
			if (!SERVO_IDS.includes(servoId)) throw new Error(`step ${n}: unknown servo ${String(m.servoId)}`);
			if (servos.has(servoId)) throw new Error(`step ${n}: servo ${servoId} appears twice`);
			servos.add(servoId);
			const r = m.raw as { from?: unknown; to?: unknown } | null | undefined;
			return {
				servoId,
				to: encoder(m.to, `step ${n} servo ${servoId}`),
				raw:
					r && Number.isFinite(Number(r.from)) && Number.isFinite(Number(r.to))
						? { from: Number(r.from), to: Number(r.to) }
						: null
			};
		});
		moves.sort((a, b) => a.servoId - b.servoId);
		return {
			id,
			label: typeof s.label === 'string' ? s.label.slice(0, 120) : '',
			durationS: roundTenth(durationS) || MIN_STEP_S,
			pauseAfterS: roundTenth(pauseAfterS),
			raw: span,
			moves
		};
	});
	return { start, steps };
}

function encoder(v: unknown, what: string): number {
	const n = Number(v);
	if (!Number.isInteger(n) || n < 0 || n > ENCODER_MAX) throw new Error(`${what}: position must be a whole number 0–${ENCODER_MAX}`);
	return n;
}

export interface ComposeOptions {
	/** The source recording's header line, as parsed JSON (copied, with the start pose as neutral). */
	sourceHeader: Record<string, unknown> | null;
	sourceName: string;
	rateHz?: number;
	now?: Date;
}

/**
 * The draft as a recording the Pi can replay (hardware/dual_arm.py v1 format):
 * header, one frame per tick with `goal` for servos 1..6, footer.
 *
 * Replay ramps the follower to header.follower_neutral, then writes each
 * frame's goal at frame.t. Each step becomes round(duration × rate) frames,
 * every servo in the step moving linearly from where it was to its target;
 * a pause becomes frames that hold the pose. Frames carry `step` (1-based, 0
 * for the start frame) so a later tool can tell where each step ends.
 */
export function composeRecording(draft: CleanDraft, opts: ComposeOptions): { jsonl: string; frames: number; durationS: number } {
	const rate = opts.rateHz && opts.rateHz > 0 ? opts.rateHz : 30;
	const header = opts.sourceHeader ?? {};
	const min = numArray(header.follower_min);
	const max = numArray(header.follower_max);
	const clamp = (i: number, v: number) => {
		const lo = min?.[i] ?? 0;
		const hi = max?.[i] ?? ENCODER_MAX;
		return Math.max(lo, Math.min(hi, Math.round(v)));
	};

	const startArr = SERVO_IDS.map((sid, i) => {
		const v = draft.start[String(sid)];
		if (!Number.isFinite(v)) throw new Error(`start pose has no position for servo ${sid}`);
		return clamp(i, v);
	});

	const lines: string[] = [];
	lines.push(
		JSON.stringify({
			...header,
			event: 'header',
			version: typeof header.version === 'string' ? header.version : '1',
			timestamp: (opts.now ?? new Date()).toISOString(),
			rate_hz: rate,
			joint_names: Array.isArray(header.joint_names) ? header.joint_names : DEFAULT_JOINT_NAMES,
			follower_neutral: startArr,
			cleaned_from: opts.sourceName,
			cleaned_steps: draft.steps.length
		})
	);

	let tick = 0;
	let pose = [...startArr];
	const frame = (step: number) => {
		lines.push(JSON.stringify({ event: 'frame', t: round4(tick / rate), step, goal: pose }));
		tick += 1;
	};
	frame(0);

	draft.steps.forEach((step, idx) => {
		const from = [...pose];
		const target = [...pose];
		for (const m of step.moves) target[m.servoId - 1] = clamp(m.servoId - 1, m.to);
		const n = Math.max(1, Math.round(step.durationS * rate));
		for (let k = 1; k <= n; k++) {
			pose = from.map((f, i) => (target[i] === f ? f : Math.round(f + ((target[i] - f) * k) / n)));
			frame(idx + 1);
		}
		const hold = Math.round(step.pauseAfterS * rate);
		for (let k = 0; k < hold; k++) frame(idx + 1);
	});

	const durationS = round4((tick - 1) / rate);
	lines.push(JSON.stringify({ event: 'footer', duration_s: durationS, frames: tick }));
	return { jsonl: lines.join('\n') + '\n', frames: tick, durationS };
}

function numArray(v: unknown): number[] | null {
	return Array.isArray(v) && v.every((x) => typeof x === 'number') ? (v as number[]) : null;
}

function round4(n: number): number {
	return Math.round(n * 10000) / 10000;
}

/** Recording names the Pi accepts (recordings_admin.py _paths), kept to a tidy subset. */
export function cleanRecordingName(name: string): string | null {
	const n = name.trim().replace(/\.jsonl$/i, '');
	if (!n || n.length > 100) return null;
	if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]*$/.test(n)) return null;
	return n;
}
