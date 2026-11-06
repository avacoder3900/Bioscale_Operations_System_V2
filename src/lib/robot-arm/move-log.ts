/**
 * Robot arm Movement Log — what counts as a movement and how it reads
 * (2026-11-06). Pure: no DB, no Pi.
 *
 * Every BIMS request that moves the arm goes through robotArmFetch; it hands
 * the method, path, body and the Pi's answer to describeArmMove(), and a
 * non-null result becomes one robot_arm_moves row. One row per servo command
 * (a slider move, each jog chunk), one row for a whole-arm command (hold,
 * Cartesian jog, torque, a play, the leader arm, a task, Stop).
 *
 * 2026-11-06: a play's row keeps every frame the Pi was given (the goal of
 * each servo at each frame time, and the fire steps), read from the same
 * JSONL the Pi replays; and the Conveyor Belt and Trapdoor Solenoid fires
 * are rows of their own.
 */
import { DEFAULT_JOINT_NAMES } from './recording-cleanup';
import { camelTitle } from './ot2-move-log';
import { FIRE_TARGETS } from './animation';

export type ArmMoveKind =
	| 'move'
	| 'jog'
	| 'jog_cartesian'
	| 'hold'
	| 'torque_on'
	| 'torque_off'
	| 'play'
	| 'leader'
	| 'record'
	| 'task'
	| 'stop'
	| 'loop_step'
	| 'reading_before'
	| 'reading_after'
	| 'fire'
	| 'fire_sequence'
	| 'conveyor'
	| 'conveyor_stop'
	| 'fires_play'
	| 'fires_stop';

export interface ArmMoveEntry {
	kind: ArmMoveKind;
	/** The one servo a per-servo command drove; null for whole-arm commands. */
	servo: number | null;
	/** Absolute goal in encoder steps, when known. */
	goal: number | null;
	/** Relative steps (a jog). */
	delta: number | null;
	/** Goals per servo id for a whole-arm command (hold, Cartesian jog). */
	goals: Record<string, number> | null;
	/** Recording, task or "dx dy dz" — what a whole-arm command ran. */
	what: string | null;
}

const KIND_TITLES: Record<ArmMoveKind, string> = {
	move: 'Move',
	jog: 'Jog',
	jog_cartesian: 'Cartesian Jog',
	hold: 'Hold',
	torque_on: 'Torque On',
	torque_off: 'Torque Off',
	play: 'Play',
	leader: 'Leader Arm',
	record: 'Record',
	task: 'Task',
	stop: 'Stop',
	loop_step: 'Loop Step',
	reading_before: 'Reading Before',
	reading_after: 'Reading After',
	fire: 'Trapdoor Solenoid Fire',
	fire_sequence: 'Trapdoor Solenoid Sequence',
	conveyor: 'Conveyor Belt Fire',
	conveyor_stop: 'Conveyor Belt Stop',
	fires_play: 'Fire Steps',
	fires_stop: 'Fire Steps Stop'
};

/** Conveyor Belt and Trapdoor Solenoid rows: GPIO, no servo moves, so no servo readings around them. */
export const FIRE_KINDS = new Set<string>(['fire', 'fire_sequence', 'conveyor', 'conveyor_stop', 'fires_play', 'fires_stop']);

/** "Solenoid A" for BCM 17, "Conveyor Belt" for 22, "GPIO 5" for anything else. */
const pinLabel = (pin: unknown): string => FIRE_TARGETS.find((t) => t.pin === pin)?.label ?? `GPIO ${String(pin)}`;

/** Arm kinds by name; an OT-2 row's kind is its commandType ("moveToWell" → "Move To Well"). */
export const kindTitle = (k: string): string => KIND_TITLES[k as ArmMoveKind] ?? camelTitle(k);

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' ? (v as Record<string, unknown>) : null);

/** Servo id from a key the Pi uses: "2", "id_2", or a joint name ("shoulder_lift"). */
export function servoIdOf(key: string): number | null {
	const m = /^(?:id_?|servo_?)?(\d)$/.exec(key);
	if (m) return Number(m[1]);
	const i = DEFAULT_JOINT_NAMES.indexOf(key);
	return i >= 0 ? i + 1 : null;
}

/** { "1": 2048, … } from the Pi's map, whichever way it keys servos. */
export function goalsById(v: unknown): Record<string, number> | null {
	const o = obj(v);
	if (!o) return null;
	const out: Record<string, number> = {};
	for (const [k, raw] of Object.entries(o)) {
		const sid = servoIdOf(k);
		const n = num(raw);
		if (sid != null && n != null) out[String(sid)] = n;
	}
	return Object.keys(out).length ? out : null;
}

const entry = (kind: ArmMoveKind, e: Partial<ArmMoveEntry> = {}): ArmMoveEntry => ({
	kind,
	servo: e.servo ?? null,
	goal: e.goal ?? null,
	delta: e.delta ?? null,
	goals: e.goals ?? null,
	what: e.what ?? null
});

/** The movement a Pi request makes, or null when it moves nothing (reads, cameras, GPIO, files). */
export function describeArmMove(method: string, path: string, body: unknown, response: unknown): ArmMoveEntry | null {
	if (method.toUpperCase() !== 'POST') return null;
	const p = path.split('?')[0];
	const b = obj(body) ?? {};
	const r = obj(response) ?? {};
	let m: RegExpExecArray | null;
	if ((m = /^\/servos\/(\d+)\/move$/.exec(p))) {
		return entry('move', { servo: Number(m[1]), goal: num(r.goal) ?? num(b.position) });
	}
	if ((m = /^\/servos\/(\d+)\/jog$/.exec(p))) {
		return entry('jog', { servo: Number(m[1]), goal: num(r.goal), delta: num(b.delta_steps) });
	}
	if (p === '/jog/cartesian') {
		const d = [b.dx_mm, b.dy_mm, b.dz_mm].map((v) => (typeof v === 'number' ? v : 0));
		return entry('jog_cartesian', { goals: goalsById(r.goal_steps), what: `dx ${d[0]} dy ${d[1]} dz ${d[2]} mm` });
	}
	if (p === '/servos/hold') return entry('hold', { goals: goalsById(r.positions) });
	if (p === '/torque') return entry(b.enable === false ? 'torque_off' : 'torque_on');
	if (p === '/replay/start') {
		const loops = num(b.loops);
		return entry('play', { what: `${String(b.source ?? '')}${loops && loops > 1 ? ` x${loops}` : ''}` || null });
	}
	if (p === '/teleop/start') return entry('leader', { what: typeof b.manufacturing_step === 'string' ? b.manufacturing_step : null });
	if (p === '/record/start') return entry('record', { what: typeof b.name === 'string' ? b.name : null });
	if ((m = /^\/tasks\/([^/]+)\/run$/.exec(p))) return entry('task', { what: decodeURIComponent(m[1]) });
	if (p === '/sessions/stop') return entry('stop');
	if (p === '/gpio/pulse') return entry('fire', { what: `${pinLabel(b.pin)} ${String(b.ms ?? '?')} ms` });
	if (p === '/gpio/sequence') {
		const pins = Array.isArray(b.pins) ? b.pins.map(pinLabel).join(', ') : '';
		return entry('fire_sequence', { what: `${pins} ${String(b.ms ?? '?')} ms, Gap ${String(b.gap_ms ?? '?')} ms` });
	}
	if (p === '/conveyor/pulse') {
		const delay = num(b.delay_ms);
		return entry('conveyor', { what: `${String(b.ms ?? '?')} ms${delay ? ` After ${delay} ms` : ''}` });
	}
	if (p === '/conveyor/stop' || p === '/conveyor/off') return entry('conveyor_stop', { what: p === '/conveyor/off' ? 'Force Off' : null });
	if (p === '/fires/play') {
		const fires = Array.isArray(b.fires) ? (b.fires as Record<string, unknown>[]) : [];
		const list = fires.slice(0, 6).map((f) => `${pinLabel(f.pin)} ${String(f.ms)} ms At ${String(f.t)} s`);
		if (fires.length > 6) list.push(`+${fires.length - 6} More`);
		return entry('fires_play', { what: [typeof b.title === 'string' ? b.title : null, list.join(', ')].filter(Boolean).join('  ') || null });
	}
	if (p === '/fires/stop') return entry('fires_stop');
	return null;
}

/*
 * A play's frames (2026-11-06). Every play is a JSONL recording the Pi
 * replays frame by frame; the row keeps those frames so a play can be read
 * frame by frame, and the per-servo summary counts direction changes inside
 * it. These are the goals the Pi was given; where the arm really ended up is
 * the Reading After row.
 */
export interface PlayFire {
	t: number;
	pin: number;
	ms: number;
	label: string;
}

export interface PlayFrames {
	rateHz: number | null;
	/** Seconds from the play's start, one per frame. */
	t: number[];
	/** goals[i][s] = servo s + 1's goal at frame i, steps. */
	goals: (number | null)[][];
	fires: PlayFire[];
}

/** Per servo over one play: where it started and ended, its travel and its direction changes. */
export interface FrameServoStats {
	first: number;
	last: number;
	min: number;
	max: number;
	/** Sum of |step| over the frames. */
	travel: number;
	reversals: number;
	/** Direction of the first and last real move (-1, 0, 1). */
	firstDir: number;
	lastDir: number;
}

/** A turn only counts once the servo has gone this far the other way (recorded frames jitter by a step or two). */
export const REVERSAL_DEADBAND_STEPS = 3;

/** The frames of a recording as the Pi writes or replays it (header / frame / footer JSONL). Null when it has none. */
export function playFramesFromJsonl(jsonl: string): PlayFrames | null {
	let rateHz: number | null = null;
	const t: number[] = [];
	const goals: (number | null)[][] = [];
	const fires: PlayFire[] = [];
	for (const line of jsonl.split(/\r?\n/)) {
		if (!line.trim()) continue;
		let rec: Record<string, unknown>;
		try {
			rec = JSON.parse(line);
		} catch {
			continue;
		}
		if (rec.event === 'header') {
			rateHz = typeof rec.rate_hz === 'number' ? rec.rate_hz : null;
			continue;
		}
		if ((rec.event !== undefined && rec.event !== 'frame') || typeof rec.t !== 'number') continue;
		let g: (number | null)[] | null = null;
		if (Array.isArray(rec.goal)) g = rec.goal.map((v) => num(v));
		else if (obj(rec.positions)) {
			const byId = goalsById(rec.positions) ?? {};
			g = Array.from({ length: 6 }, (_, i) => byId[String(i + 1)] ?? null);
		}
		if (!g) continue;
		const ft = Math.round(rec.t * 1000) / 1000;
		t.push(ft);
		goals.push(g);
		const f = obj(rec.fire);
		if (f && typeof f.pin === 'number') fires.push({ t: ft, pin: f.pin, ms: num(f.ms) ?? 0, label: pinLabel(f.pin) });
	}
	return t.length ? { rateHz, t, goals, fires } : null;
}

/** Per servo id ("1".."6"): travel and direction changes over the frames. */
export function frameStats(f: PlayFrames): Record<string, FrameServoStats> {
	const out: Record<string, FrameServoStats> = {};
	const n = Math.max(0, ...f.goals.map((g) => g.length));
	for (let s = 0; s < n; s++) {
		const vals = f.goals.map((g) => g[s]).filter((v): v is number => v != null);
		if (!vals.length) continue;
		let travel = 0;
		let reversals = 0;
		let dir = 0;
		let firstDir = 0;
		// The extreme reached in the current direction; a turn counts once the servo is DEADBAND back from it.
		let peak = vals[0];
		for (let i = 1; i < vals.length; i++) {
			const v = vals[i];
			travel += Math.abs(v - vals[i - 1]);
			if (dir === 0) {
				if (Math.abs(v - peak) >= REVERSAL_DEADBAND_STEPS) {
					dir = Math.sign(v - peak);
					firstDir = dir;
					peak = v;
				}
			} else if ((v - peak) * dir > 0) peak = v;
			else if (Math.abs(v - peak) >= REVERSAL_DEADBAND_STEPS) {
				reversals++;
				dir = -dir;
				peak = v;
			}
		}
		out[String(s + 1)] = { first: vals[0], last: vals[vals.length - 1], min: Math.min(...vals), max: Math.max(...vals), travel, reversals, firstDir, lastDir: dir };
	}
	return out;
}

/** One line for the log: "Servo 2 -> 2048", "Servo 3 +40 -> 1990", "Play pick_a". */
export function moveLine(e: Pick<ArmMoveEntry, 'kind' | 'servo' | 'goal' | 'delta' | 'goals' | 'what'>): string {
	if (e.servo != null) {
		const d = e.delta != null ? ` ${e.delta > 0 ? '+' : ''}${e.delta}` : '';
		const g = e.goal != null ? ` -> ${e.goal}` : '';
		return `Servo ${e.servo}${d}${g}`;
	}
	const parts = [kindTitle(e.kind)];
	if (e.what) parts.push(e.what);
	if (e.goals) parts.push(Object.entries(e.goals).map(([k, v]) => `${k}: ${v}`).join('  '));
	return parts.join('  ');
}

export interface ServoMoveSummary {
	servo: number;
	moves: number;
	/** How many times the servo turned back the way it came. */
	reversals: number;
}

type SummaryRow = Pick<ArmMoveEntry, 'servo' | 'goal' | 'delta' | 'goals'> & {
	kind: string;
	at: string | Date;
	ok?: boolean;
	device?: string | null;
	/** A play's per-servo frame stats: the play counts as one move of each servo it moved, and its turns count. */
	frameStats?: Record<string, FrameServoStats> | null;
};

/**
 * Per servo: how many commands drove it and how many times it reversed —
 * the "it kept going back and forth" question. Rows in any order; failed
 * rows (ok false) did not move it and are left out. A Hold sets goal =
 * present, so it is where the servo is, not a move.
 */
export function summarizeServoMoves(rows: SummaryRow[], servoCount = 6): ServoMoveSummary[] {
	const sorted = rows.filter((r) => r.ok !== false && r.device !== 'ot2' && !READING_KINDS.has(r.kind)).sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
	const state = new Map<number, { moves: number; reversals: number; last: number | null; dir: number }>();
	for (let s = 1; s <= servoCount; s++) state.set(s, { moves: 0, reversals: 0, last: null, dir: 0 });
	const step = (sid: number, goal: number | null, delta: number | null) => {
		const st = state.get(sid);
		if (!st) return;
		st.moves++;
		const d = delta ?? (goal != null && st.last != null ? goal - st.last : 0);
		const dir = Math.sign(d);
		if (dir !== 0) {
			if (st.dir !== 0 && dir !== st.dir) st.reversals++;
			st.dir = dir;
		}
		if (goal != null) st.last = goal;
		else if (st.last != null && delta != null) st.last += delta;
	};
	for (const r of sorted) {
		if (r.frameStats) {
			for (const [k, fs] of Object.entries(r.frameStats)) {
				const st = state.get(Number(k));
				if (!st || fs.travel === 0) continue;
				st.moves++;
				if (st.dir !== 0 && fs.firstDir !== 0 && fs.firstDir !== st.dir) st.reversals++;
				st.reversals += fs.reversals;
				if (fs.lastDir !== 0) st.dir = fs.lastDir;
				st.last = fs.last;
			}
		} else if (r.servo != null) step(r.servo, r.goal, r.delta);
		else if (r.kind === 'hold' && r.goals) {
			for (const [k, v] of Object.entries(r.goals)) {
				const st = state.get(Number(k));
				if (st) st.last = v;
			}
		} else if (r.goals) for (const [k, v] of Object.entries(r.goals)) step(Number(k), v, null);
	}
	return [...state.entries()].map(([servo, s]) => ({ servo, moves: s.moves, reversals: s.reversals }));
}

/*
 * Servo readings around each move (2026-11-06). robotArmFetch reads GET
 * /servos just before it sends a movement and again once the arm has
 * settled, and each read is its own row (kind reading_before /
 * reading_after) linked to the move by moveId. A per-servo move's rows name
 * that servo; a whole-arm command's rows carry all six.
 */
export const READING_KINDS = new Set(['reading_before', 'reading_after']);

export interface ServoReading {
	id: number;
	position: number | null;
	speed: number | null;
	load: number | null;
	voltage: number | null;
	temperature: number | null;
	torque: boolean | null;
}

const real = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The Pi's GET /servos answer, cleaned to the fields the log keeps. */
export function servoReadings(raw: unknown): ServoReading[] | null {
	if (!Array.isArray(raw)) return null;
	const out: ServoReading[] = [];
	for (const s of raw) {
		const o = obj(s);
		const id = num(o?.id);
		if (!o || id == null) continue;
		out.push({
			id,
			position: num(o.position),
			speed: num(o.speed),
			load: num(o.load),
			voltage: real(o.voltage),
			temperature: real(o.temperature),
			torque: typeof o.torque === 'boolean' ? o.torque : null
		});
	}
	return out.length ? out : null;
}

/** Kinds that end on their own soon after the Pi answers; sessions (play, record, leader arm, task) do not. */
export const SETTLING_KINDS = new Set<string>(['move', 'jog', 'jog_cartesian', 'hold', 'torque_on', 'torque_off', 'stop']);

/** Still when every watched servo reports speed 0 and the same position as the read before. */
export function isSettled(prev: ServoReading[] | null, cur: ServoReading[], servos: number[] | null): boolean {
	const watch = cur.filter((r) => !servos || servos.includes(r.id));
	if (!watch.length) return true;
	return watch.every((r) => {
		if (r.speed != null && r.speed !== 0) return false;
		const p = prev?.find((x) => x.id === r.id);
		return !p || p.position == null || r.position == null || Math.abs(p.position - r.position) <= 1;
	});
}

const one = (r: ServoReading) =>
	[
		r.position != null ? `Position ${r.position}` : null,
		r.temperature != null ? `${r.temperature} °C` : null,
		r.load != null ? `Load ${r.load}` : null,
		r.voltage != null ? `${r.voltage} V` : null,
		r.torque == null ? null : r.torque ? 'Torque On' : 'Torque Off'
	]
		.filter(Boolean)
		.join('  ');

/**
 * "Before  Servo 3  Position 2997  38 °C  Load 0  12.4 V  Torque On",
 * "After  Servo 3  Position 2975  Goal 2947  Off 28  …  Settled 1.2 s",
 * "Before  1: 2049 42 °C  2: 863 40 °C  …" for a whole-arm command.
 */
export function readingLine(
	phase: 'before' | 'after',
	readings: ServoReading[],
	o: { servo?: number | null; goal?: number | null; settledMs?: number | null; note?: string | null } = {}
): string {
	const parts = [phase === 'before' ? 'Before' : 'After'];
	const r = o.servo != null ? readings.find((x) => x.id === o.servo) : null;
	if (o.servo != null && r) {
		parts.push(`Servo ${o.servo}`);
		const body = one(r);
		if (phase === 'after' && o.goal != null && r.position != null) {
			parts.push(body.replace(/^(Position -?\d+)/, `$1  Goal ${o.goal}  Off ${r.position - o.goal}`));
		} else parts.push(body);
	} else {
		parts.push(readings.map((x) => `${x.id}: ${x.position ?? '?'} ${x.temperature != null ? `${x.temperature} °C` : ''}`.trim()).join('  '));
	}
	if (o.settledMs != null) parts.push(`Settled ${(o.settledMs / 1000).toFixed(1)} s`);
	if (o.note) parts.push(o.note);
	return parts.join('  ');
}
