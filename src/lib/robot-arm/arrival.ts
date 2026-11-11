/**
 * Where a play left the arm, and what a pose save stored (2026-11-10). Pure: no DB, no Pi.
 *
 * Why: on 2026-11-10 "r.r.2 hover Copy" kept its Go To Pose button because
 * the shoulder stopped 26–34 steps short of 2220 after every Go To. The
 * Movement Log had no reading after a play, so the miss could only be
 * pieced together from the next move's Reading Before. Nor did it show that
 * the pose was saved with a goal the arm had never reached (slider 2220, arm
 * 2244). An Arrival row now follows every play, and a Pose Saved row every
 * pose save, both judged with the same tolerance the pose editor uses.
 */
import type { ServoReading } from './move-log';

/**
 * "The arm is at these values": the pose editor hides Go To Pose inside this,
 * and an Arrival row calls a play Reached inside it. 80 while loaded joints
 * sat tens of steps short; 20 (Short Move's limit) since stiffness 32 on
 * 2026-11-06 lands every joint within ~9.
 */
export const AT_POSE_STEPS = 20;

/** A pose save with any servo further than this from the arm was made away from the arm (Edit Values), not at it. */
export const NEAR_POSE_STEPS = 150;

export type ApproachDirection = 'increasing' | 'decreasing' | 'still';

export interface ArrivalServo {
	servo: number;
	/** The play's last goal for this servo. */
	target: number;
	/** Where it was before the play (the Reading Before), when known. */
	from: number | null;
	/** Where it stopped. */
	position: number | null;
	/** position − target; null when not read. */
	off: number | null;
	/** Steps the servo was asked to go: target − from. */
	asked: number | null;
	/** Steps it really went: position − from. */
	moved: number | null;
	/** Which way the goal moved the servo's number (on the shoulder, decreasing lifts the arm). */
	direction: ApproachDirection | null;
	load: number | null;
	speed: number | null;
	temperature: number | null;
	torque: boolean | null;
	reached: boolean | null;
}

export interface ArrivalReport {
	toleranceSteps: number;
	/** Every servo read and within tolerance. Null when the arm could not be read. */
	reached: boolean | null;
	servos: ArrivalServo[];
	/** The servo furthest off. */
	worst: { servo: number; off: number } | null;
	/** Servos outside tolerance, worst first. */
	missed: number[];
	/** Arrival rows with a fast trace (2026-11-11): per servo swing, turns and when it went steady. */
	motion?: ServoMotion[] | null;
	/** Arrival rows with in-play samples (2026-11-11): per servo error from its goals during the play, and wobble. */
	tracking?: ServoTracking[] | null;
}

const at = (arr: (number | null)[] | null | undefined, i: number): number | null => {
	const v = arr?.[i];
	return typeof v === 'number' && Number.isFinite(v) ? v : null;
};

/** Per servo: target vs where it stopped, how far it was asked to go and went, and the load holding it there. */
export function arrivalReport(
	target: (number | null)[],
	readings: ServoReading[] | null,
	from: (number | null)[] | null,
	toleranceSteps = AT_POSE_STEPS
): ArrivalReport {
	const servos: ArrivalServo[] = [];
	for (let i = 0; i < target.length; i++) {
		const t = at(target, i);
		if (t == null) continue;
		const id = i + 1;
		const r = readings?.find((x) => x.id === id) ?? null;
		const f = at(from, i);
		const position = r?.position ?? null;
		const off = position != null ? position - t : null;
		const asked = f != null ? t - f : null;
		servos.push({
			servo: id,
			target: t,
			from: f,
			position,
			off,
			asked,
			moved: f != null && position != null ? position - f : null,
			direction: asked == null ? null : asked > 0 ? 'increasing' : asked < 0 ? 'decreasing' : 'still',
			load: r?.load ?? null,
			speed: r?.speed ?? null,
			temperature: r?.temperature ?? null,
			torque: r?.torque ?? null,
			reached: off == null ? null : Math.abs(off) <= toleranceSteps
		});
	}
	const read = servos.filter((s) => s.off != null);
	const missed = read.filter((s) => !s.reached).sort((a, b) => Math.abs(b.off!) - Math.abs(a.off!));
	const worstS = [...read].sort((a, b) => Math.abs(b.off!) - Math.abs(a.off!))[0];
	return {
		toleranceSteps,
		reached: !readings || !read.length ? null : read.length === servos.length && missed.length === 0,
		servos,
		worst: worstS ? { servo: worstS.servo, off: worstS.off! } : null,
		missed: missed.map((s) => s.servo)
	};
}

const signed = (n: number) => `${n > 0 ? '+' : ''}${n}`;
const DIR_WORD: Record<ApproachDirection, string> = { increasing: 'Increasing', decreasing: 'Decreasing', still: 'Still' };

/** One missed servo: "Servo 2  Goal 2220  At 2246  Off +26  Load -199  Decreasing  Moved -3 Of -30". */
function missedPart(s: ArrivalServo): string {
	const parts = [`Servo ${s.servo}`, `Goal ${s.target}`, `At ${s.position}`, `Off ${signed(s.off!)}`];
	if (s.load != null) parts.push(`Load ${s.load}`);
	if (s.direction && s.direction !== 'still') parts.push(DIR_WORD[s.direction]);
	if (s.moved != null && s.asked != null && s.asked !== 0) parts.push(`Moved ${signed(s.moved)} Of ${signed(s.asked)}`);
	if (s.torque === false) parts.push('Torque Off');
	return parts.join('  ');
}

/**
 * "Arrival  r.r.2 hover Copy  Missed  Servo 2  Goal 2220  At 2246  Off +26  Load -199 …",
 * "Arrival  r.r.2 hover  Reached  Worst Servo 3 Off +12", "Arrival  pick_a  Not Read".
 */
export function arrivalLine(title: string | null, r: ArrivalReport, o: { settledMs?: number | null; note?: string | null } = {}): string {
	const parts = ['Arrival'];
	if (title) parts.push(title);
	if (r.reached == null) parts.push('Not Read');
	else if (r.reached) {
		parts.push('Reached');
		if (r.worst) parts.push(`Worst Servo ${r.worst.servo} Off ${signed(r.worst.off)}`);
	} else {
		parts.push('Missed');
		for (const id of r.missed) parts.push(missedPart(r.servos.find((s) => s.servo === id)!));
	}
	if (o.settledMs != null) parts.push(`Settled ${(o.settledMs / 1000).toFixed(1)} s`);
	if (o.note) parts.push(o.note);
	return parts.join('  ');
}

export type PoseSaveAction = 'save' | 'edit' | 'duplicate';

export interface PoseSaveReport {
	action: PoseSaveAction;
	/** Servos whose saved number changed: [servo, before, after]. */
	changed: { servo: number; before: number | null; after: number }[];
	/** Saved number vs where the arm was at that moment. Null when the arm was not read. */
	arm: ArrivalReport | null;
}

/** What changed, and whether the arm was really at the numbers saved. */
export function poseSaveReport(action: PoseSaveAction, before: (number | null)[] | null, after: (number | null)[], readings: ServoReading[] | null): PoseSaveReport {
	const changed: PoseSaveReport['changed'] = [];
	for (let i = 0; i < after.length; i++) {
		const a = at(after, i);
		if (a == null) continue;
		const b = at(before, i);
		if (before && b === a) continue;
		changed.push({ servo: i + 1, before: b, after: a });
	}
	return { action, changed, arm: readings ? arrivalReport(after, readings, null) : null };
}

const ACTION_WORD: Record<PoseSaveAction, string> = { save: 'Pose Saved', edit: 'Pose Edited', duplicate: 'Pose Duplicated' };

/**
 * "Pose Edited  r.r.2 hover Copy  2: 2250 -> 2220  3: 2390 -> 2370  ⚠ Arm Not At Saved Numbers  Servo 2  Saved 2220  Arm 2244  Off +24",
 * "Pose Saved  pick  Arm At Saved Numbers".
 */
export function poseSaveLine(name: string, r: PoseSaveReport, o: { from?: string | null } = {}): string {
	const parts = [ACTION_WORD[r.action], name];
	if (o.from) parts.push(`From ${o.from}`);
	if (r.action === 'edit') parts.push(r.changed.length ? r.changed.map((c) => `${c.servo}: ${c.before ?? '?'} -> ${c.after}`).join('  ') : 'No Number Changed');
	if (!r.arm || r.arm.reached == null) parts.push('Arm Not Read');
	else if (r.arm.reached) parts.push('Arm At Saved Numbers');
	else if (r.arm.worst && Math.abs(r.arm.worst.off) > NEAR_POSE_STEPS) {
		// Edit Values or a duplicate with the arm at another pose: not a pose saved short of the arm.
		parts.push(`Arm Elsewhere  Worst Servo ${r.arm.worst.servo} Off ${signed(r.arm.worst.off)}`);
	} else {
		parts.push('⚠ Arm Not At Saved Numbers');
		for (const id of r.arm.missed) {
			const s = r.arm.servos.find((x) => x.servo === id)!;
			parts.push(`Servo ${id}  Saved ${s.target}  Arm ${s.position}  Off ${signed(s.off!)}${s.load != null ? `  Load ${s.load}` : ''}`);
		}
	}
	return parts.join('  ');
}

/*
 * The arm right after a play, sampled fast ON the Pi (GET /servos/trace,
 * 2026-11-11). Why: at shoulder I = 8 the arm shook at 0. Remove Home
 * (869–891 around 880), but BIMS reads the servos at best every ~300 ms over
 * the tunnel, and not at all while a play holds the bus, so the shake's size
 * and speed were guesses. The Pi samples every servo at up to 100 Hz the
 * moment the play lets go, and stops at once if another play is waiting.
 */
export interface ServoTrace {
	/** Seconds from the trace's start, one per sample. */
	t: number[];
	servos: { id: number; position: (number | null)[]; load: (number | null)[] }[];
	achievedHz: number | null;
	/** Why it ended early ("session started"), or null when it ran its full time. */
	stopped: string | null;
}

export interface ServoMotion {
	servo: number;
	first: number | null;
	last: number | null;
	/** Peak to peak over the trace, steps. */
	swing: number | null;
	/** Direction changes of at least SHAKE_DEADBAND_STEPS. */
	turns: number;
	/** turns / 2 / seconds: how fast it swings back and forth. */
	hz: number | null;
	/** Seconds until it stays within ±STEADY_STEPS of its last value; null when it never does. */
	steadyAfterS: number | null;
	/** Load range over the trace. */
	loadMin: number | null;
	loadMax: number | null;
	shaking: boolean;
}

/** A move of this many steps or more back the other way counts as a turn (readings jitter by 1). */
export const SHAKE_DEADBAND_STEPS = 2;
/** Shaking = at least this many turns over more than SHAKE_SWING_STEPS (the I sweep's hunting rule). */
export const SHAKE_TURNS = 2;
export const SHAKE_SWING_STEPS = 4;
export const STEADY_STEPS = 2;

/** The Pi's GET /servos/trace answer, cleaned. Null when it has none (an older Pi answers 404). */
export function servoTraceFrom(raw: unknown): ServoTrace | null {
	const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
	if (!o || !Array.isArray(o.t) || !Array.isArray(o.servos)) return null;
	const t = (o.t as unknown[]).map((v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : NaN));
	if (!t.length || t.some((v) => !Number.isFinite(v))) return null;
	const col = (v: unknown) => (Array.isArray(v) ? v.map((x) => n(x)) : t.map(() => null));
	const servos = (o.servos as unknown[])
		.map((s) => (s && typeof s === 'object' ? (s as Record<string, unknown>) : null))
		.filter((s): s is Record<string, unknown> => !!s && n(s.id) != null)
		.map((s) => ({ id: n(s.id)!, position: col(s.position), load: col(s.load) }));
	return servos.length ? { t, servos, achievedHz: n(o.achieved_hz), stopped: typeof o.stopped === 'string' ? o.stopped : null } : null;
}

/** Per servo over the trace: swing, turns, how fast, when it went steady, and whether it shook. */
export function traceMotion(trace: ServoTrace): ServoMotion[] {
	const dur = trace.t.length > 1 ? trace.t[trace.t.length - 1] - trace.t[0] : 0;
	return trace.servos.map((s) => {
		const pts = s.position.map((p, i) => ({ p, t: trace.t[i] })).filter((x): x is { p: number; t: number } => x.p != null);
		const loads = s.load.filter((v): v is number => v != null);
		if (!pts.length) return { servo: s.id, first: null, last: null, swing: null, turns: 0, hz: null, steadyAfterS: null, loadMin: null, loadMax: null, shaking: false };
		const vals = pts.map((x) => x.p);
		let turns = 0;
		let dir = 0;
		let peak = vals[0];
		for (const v of vals.slice(1)) {
			if (dir === 0) {
				if (Math.abs(v - peak) >= SHAKE_DEADBAND_STEPS) {
					dir = Math.sign(v - peak);
					peak = v;
				}
			} else if ((v - peak) * dir > 0) peak = v;
			else if (Math.abs(v - peak) >= SHAKE_DEADBAND_STEPS) {
				turns++;
				dir = -dir;
				peak = v;
			}
		}
		const last = vals[vals.length - 1];
		let steadyIdx = pts.length - 1;
		while (steadyIdx > 0 && Math.abs(pts[steadyIdx - 1].p - last) <= STEADY_STEPS) steadyIdx--;
		const swing = Math.max(...vals) - Math.min(...vals);
		// Steady only if it held still for the last quarter of the trace, at least.
		const steadyAfterS = dur > 0 && pts[pts.length - 1].t - pts[steadyIdx].t >= dur / 4 ? Math.round((pts[steadyIdx].t - trace.t[0]) * 100) / 100 : null;
		return {
			servo: s.id,
			first: vals[0],
			last,
			swing,
			turns,
			hz: dur > 0 && turns ? Math.round((turns / 2 / dur) * 10) / 10 : null,
			steadyAfterS,
			loadMin: loads.length ? Math.min(...loads) : null,
			loadMax: loads.length ? Math.max(...loads) : null,
			shaking: turns >= SHAKE_TURNS && swing > SHAKE_SWING_STEPS
		};
	});
}

/** "⚠ Shaking  Servo 2  Swing 22  3 Turns  0.5 Hz", or null when nothing shook. */
export function shakeNote(motion: ServoMotion[] | null): string | null {
	const shook = (motion ?? []).filter((m) => m.shaking);
	if (!shook.length) return null;
	return `⚠ Shaking  ${shook.map((m) => `Servo ${m.servo}  Swing ${m.swing}  ${m.turns} Turns${m.hz != null ? `  ${m.hz} Hz` : ''}`).join('  ')}`;
}

/*
 * The arm DURING a play (2026-11-11). Why: the user saw "place and remove"
 * wobble with shoulder, elbow and wrist flex at I = 4, but the log had only
 * the goals the arm was given and the 3 s after the play. The Pi now reads
 * the six positions after each frame's goals (when there is time before the
 * next frame) and keeps them per run (GET /replay/measured/{run_id}); here
 * each sample is set against that frame's goal.
 */
export interface InPlaySamples {
	/** Seconds from the loop's start, frame index, loop number, then servo 1..6 positions. */
	samples: (number | null)[][];
	skipped: number;
	readMsAvg: number | null;
	readMsMax: number | null;
}

export interface ServoTracking {
	servo: number;
	samples: number;
	/** actual − goal at the sample with the largest |error|, and when. */
	maxErr: number | null;
	maxErrAtS: number | null;
	rmsErr: number | null;
	/** Direction changes (≥ SHAKE_DEADBAND_STEPS) of the goals sent and of where the servo really went. */
	goalTurns: number;
	actualTurns: number;
	/** actualTurns − goalTurns: the servo turning back where its goal did not. */
	extraTurns: number;
	wobble: boolean;
}

/** A servo that turns back this many more times than its goals did is wobbling. */
export const WOBBLE_EXTRA_TURNS = 4;

/** The Pi's GET /replay/measured answer, cleaned. Null when it has none (an older Pi, or no samples). */
export function inPlayFrom(raw: unknown): InPlaySamples | null {
	const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
	if (!o || !Array.isArray(o.samples) || !o.samples.length) return null;
	const samples = (o.samples as unknown[]).filter(Array.isArray).map((r) => (r as unknown[]).map((v) => n(v)));
	return samples.length ? { samples, skipped: n(o.skipped) ?? 0, readMsAvg: n(o.read_ms_avg), readMsMax: n(o.read_ms_max) } : null;
}

function turnsOf(vals: number[]): number {
	let turns = 0;
	let dir = 0;
	let peak = vals[0];
	for (const v of vals.slice(1)) {
		if (dir === 0) {
			if (Math.abs(v - peak) >= SHAKE_DEADBAND_STEPS) {
				dir = Math.sign(v - peak);
				peak = v;
			}
		} else if ((v - peak) * dir > 0) peak = v;
		else if (Math.abs(v - peak) >= SHAKE_DEADBAND_STEPS) {
			turns++;
			dir = -dir;
			peak = v;
		}
	}
	return turns;
}

/** Per servo: how far it ran from its goals during the play, and whether it turned back where its goals did not. */
export function inPlayTracking(m: InPlaySamples, goals: (number | null)[][]): ServoTracking[] {
	const out: ServoTracking[] = [];
	for (let s = 1; s <= 6; s++) {
		const rows = m.samples
			.map((r) => ({ t: r[0], frame: r[1], pos: r[2 + s], goal: r[1] != null ? (goals[r[1]]?.[s - 1] ?? null) : null }))
			.filter((r): r is { t: number; frame: number; pos: number; goal: number } => r.t != null && r.frame != null && r.pos != null && r.goal != null);
		if (!rows.length) continue;
		let max = rows[0];
		let sq = 0;
		for (const r of rows) {
			if (Math.abs(r.pos - r.goal) > Math.abs(max.pos - max.goal)) max = r;
			sq += (r.pos - r.goal) ** 2;
		}
		const goalTurns = turnsOf(rows.map((r) => r.goal));
		const actualTurns = turnsOf(rows.map((r) => r.pos));
		out.push({
			servo: s,
			samples: rows.length,
			maxErr: max.pos - max.goal,
			maxErrAtS: Math.round(max.t * 100) / 100,
			rmsErr: Math.round(Math.sqrt(sq / rows.length) * 10) / 10,
			goalTurns,
			actualTurns,
			extraTurns: actualTurns - goalTurns,
			wobble: actualTurns - goalTurns >= WOBBLE_EXTRA_TURNS
		});
	}
	return out;
}

/** "In Play: Worst Servo 2 Max Error +25 At 12.4 s  ⚠ Wobble Servo 3 +6 Turns", or null without samples. */
export function inPlayNote(t: ServoTracking[] | null): string | null {
	if (!t?.length) return null;
	const worst = [...t].sort((a, b) => Math.abs(b.maxErr ?? 0) - Math.abs(a.maxErr ?? 0))[0];
	const parts = [`In Play: Worst Servo ${worst.servo} Max Error ${signed(worst.maxErr ?? 0)} At ${worst.maxErrAtS} s`];
	const wob = t.filter((x) => x.wobble);
	if (wob.length) parts.push(`⚠ Wobble ${wob.map((x) => `Servo ${x.servo} +${x.extraTurns} Turns`).join('  ')}`);
	return parts.join('  ');
}

/*
 * The servo's own registers (GET /servos/state on the Pi, 2026-11-10): the
 * goal the servo is really holding, its current draw, its error flags and
 * the gains in effect, so a miss can be told apart: load (current high, the
 * Overload flag) vs a goal that never arrived (Goal Position ≠ the play's
 * last frame) vs a gain change (P / I differ from the Change Log).
 */
export interface ServoRegisterState {
	id: number;
	goalPosition: number | null;
	position: number | null;
	speed: number | null;
	load: number | null;
	/** Raw Present_Current units; currentMa = × 6.5 mA (STS3215). */
	current: number | null;
	currentMa: number | null;
	moving: boolean | null;
	/** Register 65 bits, raw, and the ones set by name. */
	status: number | null;
	errors: string[];
	torqueLimit: number | null;
	p: number | null;
	d: number | null;
	i: number | null;
}

/** STS3215 status register (65) bits. */
export const STATUS_BITS: [number, string][] = [
	[0, 'Voltage'],
	[1, 'Angle Sensor'],
	[2, 'Temperature'],
	[3, 'Current'],
	[5, 'Overload']
];

export const statusErrors = (status: number | null): string[] => (status == null ? [] : STATUS_BITS.filter(([b]) => status & (1 << b)).map(([, n]) => n));

const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The Pi's GET /servos/state answer, cleaned. Null when it has none (an older Pi answers 404). */
export function servoRegisterStates(raw: unknown): ServoRegisterState[] | null {
	const list = Array.isArray(raw) ? raw : Array.isArray((raw as { servos?: unknown })?.servos) ? (raw as { servos: unknown[] }).servos : null;
	if (!list) return null;
	const out: ServoRegisterState[] = [];
	for (const s of list) {
		const o = s && typeof s === 'object' ? (s as Record<string, unknown>) : null;
		const id = n(o?.id);
		if (!o || id == null) continue;
		const status = n(o.status);
		const current = n(o.current);
		out.push({
			id,
			goalPosition: n(o.goal_position),
			position: n(o.position),
			speed: n(o.speed),
			load: n(o.load),
			current,
			currentMa: n(o.current_ma) ?? (current != null ? Math.round(current * 6.5) : null),
			moving: typeof o.moving === 'boolean' ? o.moving : null,
			status,
			errors: statusErrors(status),
			torqueLimit: n(o.torque_limit),
			p: n(o.p_coefficient),
			d: n(o.d_coefficient),
			i: n(o.i_coefficient)
		});
	}
	return out.length ? out : null;
}

/** "Servo Goal Register Differs: 2: 2250 (Sent 2220)", "Servo Errors: 2: Overload", or null. */
export function registerNote(states: ServoRegisterState[] | null, target: (number | null)[]): string | null {
	if (!states) return null;
	const parts: string[] = [];
	const goalDiff = states.filter((s) => s.goalPosition != null && at(target, s.id - 1) != null && Math.abs(s.goalPosition - at(target, s.id - 1)!) > 1);
	if (goalDiff.length) parts.push(`Servo Goal Register Differs: ${goalDiff.map((s) => `${s.id}: ${s.goalPosition} (Sent ${at(target, s.id - 1)})`).join('  ')}`);
	const errs = states.filter((s) => s.errors.length);
	if (errs.length) parts.push(`⚠ Servo Errors: ${errs.map((s) => `${s.id}: ${s.errors.join(', ')}`).join('  ')}`);
	return parts.length ? parts.join('  ') : null;
}
