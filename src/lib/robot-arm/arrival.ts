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
