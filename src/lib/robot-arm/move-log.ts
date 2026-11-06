/**
 * Robot arm Movement Log — what counts as a movement and how it reads
 * (2026-11-06). Pure: no DB, no Pi.
 *
 * Every BIMS request that moves the arm goes through robotArmFetch; it hands
 * the method, path, body and the Pi's answer to describeArmMove(), and a
 * non-null result becomes one robot_arm_moves row. One row per servo command
 * (a slider move, each jog chunk), one row for a whole-arm command (hold,
 * Cartesian jog, torque, a play, the leader arm, a task, Stop). A play's own
 * frames are driven by the Pi from the recording, so the row names the
 * recording rather than each frame.
 */
import { DEFAULT_JOINT_NAMES } from './recording-cleanup';
import { camelTitle } from './ot2-move-log';

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
	| 'loop_step';

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
	loop_step: 'Loop Step'
};

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
	return null;
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

type SummaryRow = Pick<ArmMoveEntry, 'servo' | 'goal' | 'delta' | 'goals'> & { kind: string; at: string | Date; ok?: boolean; device?: string | null };

/**
 * Per servo: how many commands drove it and how many times it reversed —
 * the "it kept going back and forth" question. Rows in any order; failed
 * rows (ok false) did not move it and are left out. A Hold sets goal =
 * present, so it is where the servo is, not a move.
 */
export function summarizeServoMoves(rows: SummaryRow[], servoCount = 6): ServoMoveSummary[] {
	const sorted = rows.filter((r) => r.ok !== false && r.device !== 'ot2').sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
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
		if (r.servo != null) step(r.servo, r.goal, r.delta);
		else if (r.kind === 'hold' && r.goals) {
			for (const [k, v] of Object.entries(r.goals)) {
				const st = state.get(Number(k));
				if (st) st.last = v;
			}
		} else if (r.goals) for (const [k, v] of Object.entries(r.goals)) step(Number(k), v, null);
	}
	return [...state.entries()].map(([servo, s]) => ({ servo, moves: s.moves, reversals: s.reversals }));
}
