/**
 * Robot arm — pose animation (ARM-06 Animate): the I/O half.
 *
 * Pure decisions live in $lib/robot-arm/animation (easing, path rendering,
 * sequence flattening, the Pi's recording format), unit-tested. This module
 * owns the pose / move-set / sequence records, posing (live sliders, or the
 * control arm), and playback: render the path from where the arm is now,
 * write it to the Pi as a scratch recording, start a replay.
 *
 * The 2026-10-22 redo (PRD §13) in one paragraph: every move is ABSOLUTE.
 * A pose made with the sliders stores the goals the operator set, and the
 * arm is always sent to a pose as a rendered path of absolute goals (Go to
 * pose is a one-pose play), so it ends in the same place whatever it did
 * before. The old Go to chained relative jogs (goal = present + 300) fired
 * while the arm was still moving, so where it stopped depended on where it
 * started. Torque is never left off: the Pi drops follower torque when a
 * session stops, so BIMS turns it straight back on (the servos return to
 * their last goal, which is the pose).
 *
 * Pi calls:
 *   GET  /servos                 follower positions, temperatures, torque state
 *   POST /servos/{id}/move       live slider: one servo to an absolute goal
 *   POST /servos/{id}/jog        fallback for /move on an older Pi; droop settle
 *   POST /teleop/start           follower tracks the control (leader) arm under torque
 *   POST /sessions/stop          stop that / a play
 *   POST /torque                 torque back ON after a session dropped it
 *   POST /servos/hold            goal := present, torque ON (no jump) — hold.py, if installed
 *   POST /recordings/restore     write the rendered path
 *   POST /replay/start           play it
 *   GET  /gpio/status            before a path with fire steps: can this Pi's replay fire?
 *   POST /gpio/pulse             Test fire from the editor
 */
import { connectDB, AuditLog, generateId } from '$lib/server/db';
import { RobotArmMoveSet, RobotArmPose, RobotArmPoseCalibration, RobotArmRun, RobotArmSequence } from '$lib/server/db/models';
import { recordingStem, robotArm, type RecordingSidecar, type ServoState } from './robot-arm-client';
import { DEFAULT_JOINT_NAMES } from '$lib/robot-arm/recording-cleanup';
import {
	autoDurationS,
	buildPath,
	cleanAnimationName,
	cleanKeyframes,
	cleanOffsets,
	cleanPoseIds,
	cleanPositions,
	estimateTrim,
	planPoseDelete,
	type PoseSkip,
	composeAnimationJsonl,
	fireFrames,
	flattenSequence,
	heatCheck,
	isEasing,
	jogChunks,
	keyframePositions,
	nextTrim,
	pathStats,
	solenoidLabel,
	solenoidPin,
	tooFast,
	trimFromSettle,
	DEFAULT_RATE_HZ,
	MAX_PULSE_MS,
	MIN_PULSE_MS,
	type Solenoid,
	type SolenoidStatus,
	ENCODER_MAX,
	JOG_CHUNK_STEPS,
	MAX_OFFSET_STEPS,
	MAX_TRANSITION_S,
	MAX_TRIM_STEPS,
	MIN_TRANSITION_S,
	SERVO_COUNT,
	SERVO_TEMP_STOP_C,
	TRIM_DONE_STEPS,
	TRIM_SERVOS,
	type Easing,
	type Keyframe,
	type RenderedPath,
	type ResolvedKeyframe,
	type SequenceItem,
	type TrimSample
} from '$lib/robot-arm/animation';

type User = { _id: string; username: string };

/** Scratch recording every Play / Go to writes on the Pi (overwritten each time). */
export const PREVIEW_RECORDING = 'animate-preview';
/** The Pi caps one jog at 300 steps. */
const JOG_CHUNK = JOG_CHUNK_STEPS;
/** Go to pose holds the pose this long at the end (time for the Pi to settle a reading pose). */
const GOTO_HOLD_S = 1;

export class AnimateError extends Error {
	constructor(
		message: string,
		readonly status = 400
	) {
		super(message);
	}
}

async function audit(user: User, action: string, tableName: string, recordId: string, newData: Record<string, unknown>) {
	await AuditLog.create({
		_id: generateId(),
		tableName,
		recordId,
		action,
		newData: { ...newData, userId: user._id },
		changedBy: user.username,
		changedAt: new Date()
	});
}

const opRef = (u: User) => ({ _id: u._id, username: u.username });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function cleanName(raw: unknown, what: string): string {
	const name = String(raw ?? '').trim();
	if (!name) throw new AnimateError(`A ${what} needs a name.`);
	if (name.length > 80) throw new AnimateError(`${what} names are limited to 80 characters.`);
	return name;
}

function cleanNotes(raw: unknown): string | null {
	const n = String(raw ?? '').trim();
	return n ? n.slice(0, 500) : null;
}

// ── the arm ──────────────────────────────────────────────────────────────

export interface ArmNow {
	positions: number[];
	/** °C per servo (index = id − 1); null where the Pi did not report one. */
	temps: (number | null)[];
	/** All six torque-on; null when the Pi does not report it. */
	torqueOn: boolean | null;
	servos: ServoState[];
}

function servoMessage(err: unknown): string {
	const msg = (err as Error).message ?? String(err);
	if (/robot-arm 404/.test(msg)) return 'The Pi has no GET /servos route yet (services/robot-arm/scripts/install_servos_route.py).';
	return msg;
}

/** Follower positions (servo 1..6), temperatures and torque state. Read-only, no session needed. */
export async function readArm(): Promise<ArmNow> {
	let servos: ServoState[];
	try {
		servos = await robotArm.listServosRetry();
	} catch (err) {
		throw new AnimateError(`Could not read the follower: ${servoMessage(err)}`, 502);
	}
	if (!Array.isArray(servos) || !servos.length) throw new AnimateError('The follower reported no servos.', 502);
	const positions: number[] = [];
	const temps: (number | null)[] = [];
	for (let sid = 1; sid <= SERVO_COUNT; sid++) {
		const s = servos.find((x) => x?.id === sid);
		if (!s || !Number.isFinite(s.position)) throw new AnimateError(`Servo ${sid} did not report a position.`, 502);
		positions.push(Math.round(s.position));
		temps.push(Number.isFinite(s.temperature) ? Number(s.temperature) : null);
	}
	const torques = servos.filter((s) => s.id >= 1 && s.id <= SERVO_COUNT).map((s) => s.torque);
	const torqueOn = torques.every((t) => typeof t === 'boolean') ? torques.every(Boolean) : null;
	return { positions, temps, torqueOn, servos };
}

/**
 * Refuse to start a motion when a servo is at or above SERVO_TEMP_STOP_C:
 * the STS3215 cuts its own torque at ~70 °C, and a joint that quits mid-move
 * drops the arm. Hot-but-allowed servos come back as warnings.
 */
export function requireCool(now: ArmNow): string[] {
	const h = heatCheck(now.temps);
	if (h.tooHot.length) {
		const list = h.tooHot.map((sid) => `servo ${sid} ${now.temps[sid - 1]} °C`).join(', ');
		throw new AnimateError(`Too hot to move: ${list} (limit ${SERVO_TEMP_STOP_C} °C). Let the arm rest with torque on, or power it down, until it cools.`, 409);
	}
	return h.hot.length ? [`Running warm: ${h.hot.map((sid) => `servo ${sid} ${now.temps[sid - 1]} °C`).join(', ')}.`] : [];
}

export async function requireIdle() {
	let active;
	try {
		active = (await robotArm.getActive()).active;
	} catch (err) {
		throw new AnimateError(`Cannot reach the arm: ${(err as Error).message}`, 502);
	}
	if (active) throw new AnimateError(`A ${active.kind} session is using the arm. Stop it first.`, 409);
}

/**
 * Torque back on after a session ended. The Pi's teleop and (older) replay
 * loops write torque OFF when they stop, which lets the arm sag off where it
 * was. Turning it on drives each servo back to its last goal — the pose the
 * session left it at — so this is a small lift back, not a jump. One retry.
 */
export async function torqueBackOn(): Promise<{ ok: boolean; error: string | null }> {
	let error: string | null = null;
	for (let i = 0; i < 2; i++) {
		if (i) await sleep(300);
		try {
			await robotArm.setTorque(true);
			return { ok: true, error: null };
		} catch (e) {
			error = (e as Error).message;
		}
	}
	return { ok: false, error };
}

export interface HoldResult {
	held: boolean;
	/** Why torque is still off, when it is. */
	error: string | null;
}

/**
 * Torque on. Prefers the Pi's hold route (goal := present first, so nothing
 * moves); without it (404 — never installed on arm-pi as of 2026-10-22) a
 * plain torque-on sends each servo to its last goal, which after a play or a
 * control-arm session is where the arm already is. The page warns before
 * calling this.
 */
export async function holdArm(user: User): Promise<HoldResult> {
	await connectDB();
	await requireIdle();
	try {
		const r = await robotArm.holdServos();
		await audit(user, 'robot_arm.animate.hold', 'robot_arm_poses', 'arm', { positions: r.positions, via: 'hold' });
		return { held: !!r.held, error: r.held ? null : 'The Pi did not confirm the hold.' };
	} catch (err) {
		const msg = (err as Error).message ?? String(err);
		if (!/robot-arm 404/.test(msg)) return { held: false, error: `Torque is still OFF: ${msg}` };
	}
	const t = await torqueBackOn();
	await audit(user, 'robot_arm.animate.hold', 'robot_arm_poses', 'arm', { via: 'torque', ok: t.ok, error: t.error });
	return { held: t.ok, error: t.ok ? null : `Torque is still OFF: ${t.error}` };
}

// ── live sliders ─────────────────────────────────────────────────────────
//
// Each slider drives one servo of the real arm to an ABSOLUTE goal, so
// posing is just moving sliders and watching the arm. The browser sends at
// most a short step from its last goal per request (stepToward) and only one
// request at a time, which also keeps the Pi's non-thread-safe bus to one
// caller: every request reads the arm first (temperature, torque, how far the
// move is) and then writes the goals.

export interface LiveResult {
	/** Goals written, by servo id. */
	goals: Record<number, number>;
	/** The arm as read just before the goals were written. */
	positions: number[];
	temps: (number | null)[];
	torqueOn: boolean | null;
	warnings: string[];
	/** 'move' = absolute goal route; 'jog' = older Pi without it (goal = present + delta). */
	via: 'move' | 'jog';
}

/** Set by the first 404 from /servos/{id}/move; the jog fallback is used from then on. */
let moveRouteMissing = false;

/**
 * Send servos to absolute goals (live slider). Refused while a session owns
 * the arm, when torque is off, or when a servo is too hot. No distance
 * limit: a typed value is where the joint goes (operator decision
 * 2026-10-23 — the 600-step cap refused "Servo 1 is 693 steps from that
 * value"; the only bounds left are the encoder range and the servo's own
 * EEPROM angle limits on the Pi). The arm MOVES. Not audited per move —
 * the pose save that ends an edit is.
 */
export async function liveMove(input: { goals: unknown }): Promise<LiveResult> {
	const raw = input.goals && typeof input.goals === 'object' ? (input.goals as Record<string, unknown>) : null;
	if (!raw) throw new AnimateError('goals must be { servoId: position }.');
	const goals: Record<number, number> = {};
	for (const [k, v] of Object.entries(raw)) {
		const sid = Number(k);
		const pos = Math.round(Number(v));
		if (!Number.isInteger(sid) || sid < 1 || sid > SERVO_COUNT) throw new AnimateError(`Servo must be 1..${SERVO_COUNT}.`);
		if (!Number.isFinite(pos)) throw new AnimateError(`Servo ${sid}: position is not a number.`);
		goals[sid] = Math.max(0, Math.min(ENCODER_MAX, pos));
	}
	if (!Object.keys(goals).length) throw new AnimateError('Nothing to move.');
	await requireIdle();
	const now = await readArm();
	if (now.torqueOn === false) throw new AnimateError('Torque is off — press Torque on first.', 409);
	const warnings = requireCool(now);
	let via: LiveResult['via'] = moveRouteMissing ? 'jog' : 'move';
	for (const [k, pos] of Object.entries(goals)) {
		const sid = Number(k);
		try {
			if (via === 'move') {
				try {
					await robotArm.moveJoint(sid, pos);
					continue;
				} catch (err) {
					if (!/robot-arm 404/.test((err as Error).message ?? '')) throw err;
					moveRouteMissing = true;
					via = 'jog';
				}
			}
			// Older Pi: a jog of (goal − present) from the read just taken. Exact while the
			// arm is at rest, which a slider-paced edit almost always is.
			for (const piece of jogChunks(pos - now.positions[sid - 1], JOG_CHUNK)) await robotArm.jogJoint(sid, piece);
		} catch (err) {
			const msg = (err as Error).message ?? String(err);
			if (/robot-arm 409/.test(msg)) throw new AnimateError(/torque/i.test(msg) ? `Torque is off on servo ${sid} — press Torque on first.` : `The arm is busy: ${msg}`, 409);
			throw new AnimateError(`Servo ${sid} did not move: ${msg}`, 502);
		}
	}
	return { goals, positions: now.positions, temps: now.temps, torqueOn: now.torqueOn, warnings, via };
}

// ── pose with the control (leader) arm ───────────────────────────────────
//
// A teleop session snaps the follower's goal to where it is, turns torque ON
// and then drives it to wherever the leader is, so the follower is powered
// and where the operator put it. Good for getting roughly into a pose fast;
// the sliders finish it.

/** Stamped on the teleop runs the Animate tab starts, so the Runs tab can tell them apart. */
export const LEADER_POSING_STEP = 'animate-pose';
/** Teleop rate while posing; the follower only has to keep up with a hand. */
const LEADER_POSING_RATE_HZ = 30;
/** After the stop + torque-on the follower is still lifting back onto its last goal; wait before reading it. */
const SETTLE_MS = 500;

export interface LeaderPosing {
	runId: string;
}

function leaderMessage(err: unknown): string {
	const msg = (err as Error).message ?? String(err);
	if (/robot-arm 503/.test(msg) && /leader/i.test(msg)) {
		return 'The Pi reports no control (leader) arm connected — check its USB and power on the Control tab.';
	}
	if (/robot-arm 409/.test(msg)) return `The Pi refused: ${msg}`;
	return msg;
}

async function startTeleopForPosing(user: User, why: string): Promise<LeaderPosing> {
	let started;
	try {
		started = await robotArm.startTeleop({ rate_hz: LEADER_POSING_RATE_HZ, triggered_by: opRef(user), manufacturing_step: LEADER_POSING_STEP });
	} catch (err) {
		throw new AnimateError(leaderMessage(err), 502);
	}
	await audit(user, 'robot_arm.animate.leader_posing_start', 'robot_arm_poses', 'arm', { runId: started.run_id, rateHz: LEADER_POSING_RATE_HZ, why });
	return { runId: started.run_id };
}

/** Is the follower tracking the control arm right now (any teleop session, whoever started it)? */
export async function leaderPosingActive(): Promise<LeaderPosing | null> {
	const a = (await robotArm.getActive()).active;
	return a?.kind === 'teleop' ? { runId: a.run_id } : null;
}

/**
 * Pose with the control arm: start a teleop session. The follower snaps its
 * goal to where it is, torque ON, then follows the leader (which goes limp)
 * at 30 Hz. Poses are then taken with savePoseFromLeader; stopLeaderPosing
 * ends it with the follower holding.
 */
export async function startLeaderPosing(user: User): Promise<LeaderPosing> {
	await connectDB();
	await requireIdle();
	requireCool(await readArm());
	return startTeleopForPosing(user, 'start');
}

/**
 * Stop the teleop session and put torque straight back on. The Pi writes
 * torque OFF on the follower when teleop stops (every control-arm save before
 * 2026-10-22 logged torqueOnAtCapture: false — the arm was read after sagging
 * for 400 ms). The last goal is still the leader's position, so torque-on
 * brings the follower back up onto it.
 */
async function stopTeleopHolding(): Promise<{ stoppedRunId: string | null; torque: { ok: boolean; error: string | null } }> {
	let stoppedRunId: string | null;
	try {
		stoppedRunId = (await robotArm.stop()).stopped_run_id ?? null;
	} catch (err) {
		throw new AnimateError(`Could not stop following the control arm: ${(err as Error).message}`, 502);
	}
	return { stoppedRunId, torque: await torqueBackOn() };
}

export interface LeaderPoseResult {
	pose: PoseSummary;
	/** The follower is following the control arm again (a new teleop run). */
	resumed: boolean;
	runId: string | null;
	/** Why it is not following, when it is not. */
	warning: string | null;
}

/**
 * Save the follower's position while posing with the control arm. The Pi's
 * driver is not thread-safe and the teleop thread owns the bus, so it is
 * never read mid-session: stop (torque straight back on), let it settle on
 * the leader's last position, read it, save, then start a fresh teleop so the
 * operator carries on. The pose is a READING (droop-corrected when played).
 */
export async function savePoseFromLeader(user: User, input: { name: unknown; notes?: unknown; resume: boolean }): Promise<LeaderPoseResult> {
	await connectDB();
	const name = cleanName(input.name, 'pose');
	await assertPoseNameFree(name);
	const posing = await leaderPosingActive();
	if (!posing) throw new AnimateError('The follower is not following the control arm — press "Follow the control arm" first.', 409);
	const stop = await stopTeleopHolding();
	await sleep(SETTLE_MS);
	const now = await readArm();
	const _id = generateId();
	await RobotArmPose.create({ _id, name, positions: now.positions, basis: 'reading', notes: cleanNotes(input.notes), createdBy: opRef(user) });
	await audit(user, 'robot_arm.animate.pose_save', 'robot_arm_poses', _id, {
		name,
		positions: now.positions,
		basis: 'reading',
		torqueOnAtCapture: now.torqueOn,
		torqueRestored: stop.torque.ok,
		temps: now.temps,
		source: 'leader',
		pausedRunId: posing.runId
	});
	let warning: string | null = !stop.torque.ok || now.torqueOn === false ? `Torque could not be turned back on (${stop.torque.error ?? 'the servos report it off'}), so the pose may be low — check it.` : null;
	let resumed = false;
	let runId: string | null = null;
	if (input.resume) {
		try {
			runId = (await startTeleopForPosing(user, 'after pose_save')).runId;
			resumed = true;
		} catch (err) {
			warning = [warning, `Saved, but the follower is no longer following the control arm: ${(err as Error).message} It is holding where it is.`].filter(Boolean).join(' ');
		}
	}
	return { pose: poseSummary(await RobotArmPose.findById(_id).lean()), resumed, runId, warning };
}

/** Done posing: stop the teleop session and keep the follower holding (torque back on). */
export async function stopLeaderPosing(user: User): Promise<{ stoppedRunId: string | null; torqueOn: boolean; error: string | null }> {
	await connectDB();
	const posing = await leaderPosingActive();
	if (!posing) return { stoppedRunId: null, torqueOn: true, error: null };
	const r = await stopTeleopHolding();
	await audit(user, 'robot_arm.animate.leader_posing_stop', 'robot_arm_poses', 'arm', { runId: r.stoppedRunId, torqueOn: r.torque.ok, error: r.torque.error });
	return { stoppedRunId: r.stoppedRunId, torqueOn: r.torque.ok, error: r.torque.error };
}

// ── poses ────────────────────────────────────────────────────────────────

export type PoseBasis = 'goal' | 'reading';

export interface PoseSummary {
	_id: string;
	name: string;
	positions: number[];
	/** goal = set with the sliders, played exactly; reading = encoder capture, droop-corrected. */
	basis: PoseBasis;
	/** Droop trim added to the goal when played (six entries), or null if never measured. Reading poses only. */
	trim: number[] | null;
	trimMeasuredAt: string | null;
	notes: string | null;
	archived: boolean;
	createdAt: string | null;
	updatedAt: string | null;
	createdBy: { username?: string } | null;
}

export function poseSummary(d: any): PoseSummary {
	const basis: PoseBasis = d.basis === 'goal' ? 'goal' : 'reading';
	const trim = basis === 'reading' && Array.isArray(d.trim) && d.trim.length === SERVO_COUNT ? d.trim.map(Number) : null;
	return {
		_id: String(d._id),
		name: d.name,
		positions: (d.positions ?? []).map(Number),
		basis,
		trim,
		trimMeasuredAt: d.trimMeasuredAt ? new Date(d.trimMeasuredAt).toISOString() : null,
		notes: d.notes ?? null,
		archived: !!d.archivedAt,
		createdAt: d.createdAt ? new Date(d.createdAt).toISOString() : null,
		updatedAt: d.updatedAt ? new Date(d.updatedAt).toISOString() : null,
		createdBy: d.createdBy ?? null
	};
}

export async function listPoses(): Promise<PoseSummary[]> {
	await connectDB();
	const rows = await RobotArmPose.find({}).select('-lastPlay').sort({ archivedAt: 1, createdAt: -1 }).lean();
	return (rows as any[]).map(poseSummary);
}

async function assertPoseNameFree(name: string, exceptId?: string) {
	const clash = await RobotArmPose.findOne({
		archivedAt: null,
		name: { $regex: `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' },
		...(exceptId ? { _id: { $ne: exceptId } } : {})
	})
		.select('_id')
		.lean();
	if (clash) throw new AnimateError(`A pose called "${name}" already exists.`);
}

function positionsOrThrow(raw: unknown): number[] {
	try {
		return cleanPositions(raw);
	} catch (e) {
		throw new AnimateError((e as Error).message);
	}
}

/**
 * A new pose from the sliders: `positions` are the goals the operator set
 * (basis goal). Without positions, the arm's encoders are read instead
 * (basis reading) — "save where the arm is".
 */
export async function createPose(user: User, input: { name: unknown; notes?: unknown; positions?: unknown }): Promise<PoseSummary> {
	await connectDB();
	const name = cleanName(input.name, 'pose');
	await assertPoseNameFree(name);
	let positions: number[];
	let basis: PoseBasis;
	let temps: (number | null)[] | null = null;
	if (input.positions != null) {
		positions = positionsOrThrow(input.positions);
		basis = 'goal';
	} else {
		await requireIdle();
		const now = await readArm();
		positions = now.positions;
		temps = now.temps;
		basis = 'reading';
	}
	const _id = generateId();
	await RobotArmPose.create({ _id, name, positions, basis, notes: cleanNotes(input.notes), createdBy: opRef(user) });
	await audit(user, 'robot_arm.animate.pose_save', 'robot_arm_poses', _id, { name, positions, basis, source: basis === 'goal' ? 'sliders' : 'arm', ...(temps ? { temps } : {}) });
	return poseSummary(await RobotArmPose.findById(_id).lean());
}

/**
 * Save the sliders into an existing pose. It becomes a goal pose: played
 * exactly as set, so any droop trim (which only made sense for a reading) is
 * dropped. Every move set using the pose follows.
 */
export async function setPosePositions(user: User, id: string, raw: unknown): Promise<{ pose: PoseSummary; moved: number[] }> {
	await connectDB();
	const before = (await RobotArmPose.findById(id).lean()) as any;
	if (!before) throw new AnimateError('Pose not found.', 404);
	if (before.archivedAt) throw new AnimateError('That pose is archived — restore it first.');
	const positions = positionsOrThrow(raw);
	const old: number[] = (before.positions ?? []).map(Number);
	await RobotArmPose.updateOne({ _id: id }, { $set: { positions, basis: 'goal', trim: [], trimMeasuredAt: null, trimMeasuredBy: null } });
	await audit(user, 'robot_arm.animate.pose_edit', 'robot_arm_poses', id, {
		name: before.name,
		before: old,
		after: positions,
		beforeBasis: before.basis ?? 'reading',
		clearedTrim: Array.isArray(before.trim) && before.trim.length ? before.trim : null
	});
	return { pose: poseSummary(await RobotArmPose.findById(id).lean()), moved: positions.map((p, i) => p - (old[i] ?? p)) };
}

export async function updatePose(user: User, id: string, input: { name: unknown; notes?: unknown }): Promise<PoseSummary> {
	await connectDB();
	const before = (await RobotArmPose.findById(id).lean()) as any;
	if (!before) throw new AnimateError('Pose not found.', 404);
	const name = cleanName(input.name, 'pose');
	await assertPoseNameFree(name, id);
	const set = { name, notes: cleanNotes(input.notes) };
	await RobotArmPose.updateOne({ _id: id }, { $set: set });
	await audit(user, 'robot_arm.animate.pose_update', 'robot_arm_poses', id, { before: { name: before.name, notes: before.notes }, after: set });
	return poseSummary(await RobotArmPose.findById(id).lean());
}

export async function setPoseArchived(user: User, id: string, archived: boolean): Promise<void> {
	await connectDB();
	const doc = (await RobotArmPose.findById(id).lean()) as any;
	if (!doc) throw new AnimateError('Pose not found.', 404);
	if (!archived) await assertPoseNameFree(doc.name, id);
	await RobotArmPose.updateOne({ _id: id }, { $set: { archivedAt: archived ? new Date() : null } });
	await audit(user, archived ? 'robot_arm.animate.pose_archive' : 'robot_arm.animate.pose_restore', 'robot_arm_poses', id, { name: doc.name });
}

export interface PoseBulkResult {
	done: string[];
	skipped: PoseSkip[];
}

function poseIdsOrThrow(raw: unknown[]): string[] {
	try {
		return cleanPoseIds(raw);
	} catch (e) {
		throw new AnimateError((e as Error).message);
	}
}

/**
 * Archive (or restore) many poses: each goes through setPoseArchived, so a
 * restore still refuses a name that is taken (two archived "Home" poses
 * restore one) and every pose gets its own audit entry. Poses already in
 * the asked state are left alone.
 */
export async function setPosesArchived(user: User, rawIds: unknown[], archived: boolean): Promise<PoseBulkResult> {
	await connectDB();
	const ids = poseIdsOrThrow(rawIds);
	const docs = (await RobotArmPose.find({ _id: { $in: ids } }).select('_id name archivedAt').lean()) as any[];
	const byId = new Map(docs.map((d) => [String(d._id), d]));
	const out: PoseBulkResult = { done: [], skipped: [] };
	for (const id of ids) {
		const d = byId.get(id);
		if (!d) {
			out.skipped.push({ id, name: id, reason: 'not found' });
			continue;
		}
		if (!!d.archivedAt === archived) continue;
		try {
			await setPoseArchived(user, id, archived);
			out.done.push(id);
		} catch (err) {
			if (!(err instanceof AnimateError)) throw err;
			out.skipped.push({ id, name: d.name, reason: err.message });
		}
	}
	return out;
}

/**
 * Delete archived poses for good. Only poses no move set uses (planPoseDelete);
 * each pose's active camera references are retired (kept, as history), and
 * the audit entry carries the whole pose so it can be put back by hand.
 */
export async function deleteArchivedPoses(user: User, rawIds: unknown[]): Promise<PoseBulkResult> {
	await connectDB();
	const ids = poseIdsOrThrow(rawIds);
	const [docs, sets] = (await Promise.all([
		RobotArmPose.find({ _id: { $in: ids } }).select('-lastPlay').lean(),
		RobotArmMoveSet.find({ 'keyframes.poseId': { $in: ids } }).select('name keyframes.poseId').lean()
	])) as [any[], any[]];
	const plan = planPoseDelete(
		ids,
		docs.map((d) => ({ _id: String(d._id), name: d.name, archived: !!d.archivedAt })),
		sets.map((s) => ({ name: s.name, poseIds: (s.keyframes ?? []).map((k: any) => String(k.poseId ?? '')).filter(Boolean) }))
	);
	const byId = new Map(docs.map((d) => [String(d._id), d]));
	const out: PoseBulkResult = { done: [], skipped: plan.skipped };
	for (const id of plan.deletable) {
		const pose = byId.get(id);
		// Still archived: a restore from another tab since the plan wins.
		const res = await RobotArmPose.deleteOne({ _id: id, archivedAt: { $ne: null } });
		if (!res.deletedCount) {
			out.skipped.push({ id, name: pose.name, reason: 'restored meanwhile' });
			continue;
		}
		const refs = await RobotArmPoseCalibration.updateMany({ poseId: id, status: 'active' }, { $set: { status: 'superseded', supersededAt: new Date(), supersededBy: null } });
		await audit(user, 'robot_arm.animate.pose_delete', 'robot_arm_poses', id, { name: pose.name, pose: JSON.parse(JSON.stringify(pose)), referencesRetired: refs.modifiedCount });
		out.done.push(id);
	}
	return out;
}

/**
 * Go to a pose: played like a one-pose move set — a smooth path of absolute
 * goals from where the arm is, ending held on the pose — so it lands in the
 * same place whatever the arm did before. Returns the play for the page's
 * playback poll; the page's afterPlay puts torque back on (older Pi) and,
 * for a reading pose, learns its droop. The arm MOVES.
 */
export async function goToPose(user: User, poseId: string): Promise<PlayResult> {
	await connectDB();
	const pose = (await RobotArmPose.findById(poseId).select('-lastPlay').lean()) as any;
	if (!pose) throw new AnimateError('Pose not found.', 404);
	const summary = poseSummary(pose);
	const keyframes = resolveKeyframes([{ poseId, holdS: GOTO_HOLD_S, durationS: 1, easing: 'ease' }], new Map([[poseId, summary]]), await trimSamples());
	return writeAndPlay(user, { title: summary.name, keyframes, rateHz: DEFAULT_RATE_HZ, kind: 'pose', id: poseId });
}

// ── droop (automatic) ────────────────────────────────────────────────────

/** The settle pass only nudges the arm; it must already be at (or near) the target. */
const DROOP_NEAR_STEPS = 150;
const DROOP_SETTLE_MS = 1200;
const DROOP_MAX_ROUNDS = 4;

export interface DroopResult {
	trim: number[];
	/** Target − where the arm settled on the last round (≈0 when the trim works). */
	residual: number[];
	rounds: number;
	done: boolean;
	/** Where the first round's trim came from. */
	startedFrom: 'measured' | 'estimated' | 'none';
	warnings: string[];
}

/** Every live pose with a learned trim, as samples for estimateTrim. */
async function trimSamples(exceptId?: string): Promise<TrimSample[]> {
	const rows = (await RobotArmPose.find({ 'trim.5': { $exists: true }, archivedAt: null, basis: { $ne: 'goal' } }).select('_id positions trim').lean()) as any[];
	return rows.filter((d) => String(d._id) !== exceptId).map((d) => ({ positions: d.positions.map(Number), trim: d.trim.map(Number) }));
}

/**
 * Why the claw ends up lower than the pose: replay writes each frame's goal
 * and nothing else, and under gravity a loaded STS3215 settles a few to a few
 * tens of steps SHORT of its goal (its position loop is proportional). A pose
 * captured where the joints really were (by hand, or the follower's encoders
 * under teleop) then plays back with every loaded joint short, on the
 * gravity side.
 *
 * The correction runs by itself whenever the arm is known to be sitting at a
 * pose — at the end of every Go to pose and every Play that finishes — with
 * no operator step: command goal = target + trim on servos 1–5 (a jog of
 * goal − present sets the goal exactly), let it settle, add whatever it is
 * still short to the trim, repeat until it lands within TRIM_DONE_STEPS. It
 * starts from the pose's last trim (or an estimate from nearby learned
 * poses), so a pose that has been learned settles in one round. The trim is
 * saved on the pose and every later Play / Save to Pi adds it to the goal.
 * The arm MOVES a few steps and ends holding the target.
 */
async function settleAtPose(user: User, pose: any, target: number[], now: ArmNow, reason: 'go_to' | 'play_end'): Promise<DroopResult> {
	if (now.torqueOn === false) throw new AnimateError('torque is off', 409);
	const far = TRIM_SERVOS.filter((sid) => Math.abs(target[sid - 1] - now.positions[sid - 1]) > DROOP_NEAR_STEPS);
	if (far.length) throw new AnimateError(`servo ${far.join(', ')} is more than ${DROOP_NEAR_STEPS} steps from "${pose.name}"`, 409);

	const learned = Array.isArray(pose.trim) && pose.trim.length === SERVO_COUNT ? (pose.trim as number[]).map(Number) : null;
	const estimated = learned ? null : estimateTrim(pose.positions.map(Number), await trimSamples(String(pose._id)));
	let trim: number[] = learned ?? estimated ?? new Array(SERVO_COUNT).fill(0);
	const startedFrom: DroopResult['startedFrom'] = learned ? 'measured' : estimated ? 'estimated' : 'none';
	let residual: number[] = new Array(SERVO_COUNT).fill(0);
	let done = false;
	let rounds = 0;
	const history: { goal: number[]; settled: number[] }[] = [];
	while (rounds < DROOP_MAX_ROUNDS) {
		rounds++;
		const goal = keyframePositions(target, null, trim);
		for (const sid of TRIM_SERVOS) {
			// A jog sets goal = present + delta, so this writes goal exactly — even a
			// zero jog, which replaces whatever goal the servo had with "here".
			const delta = goal[sid - 1] - now.positions[sid - 1];
			try {
				await robotArm.jogJoint(sid, delta);
			} catch (err) {
				throw new AnimateError(`servo ${sid} did not take the correction: ${(err as Error).message}`, 502);
			}
		}
		await new Promise((r) => setTimeout(r, DROOP_SETTLE_MS));
		now = await readArm();
		history.push({ goal, settled: now.positions });
		const step = nextTrim(target, now.positions, trim);
		residual = step.residual;
		done = step.done;
		trim = step.trim;
		if (done) break;
	}

	const warnings: string[] = [];
	for (const sid of TRIM_SERVOS) {
		const r = residual[sid - 1];
		if (Math.abs(r) > TRIM_DONE_STEPS && Math.abs(trim[sid - 1]) >= MAX_TRIM_STEPS)
			warnings.push(`Servo ${sid} is still ${r} steps off with the droop correction at its ${MAX_TRIM_STEPS}-step limit — it may be stalled, blocked or overloaded.`);
	}

	const stored = trim.some((t) => t !== 0) ? trim : [];
	await RobotArmPose.updateOne({ _id: pose._id }, { $set: { trim: stored, trimMeasuredAt: new Date(), trimMeasuredBy: opRef(user) } });
	await audit(user, 'robot_arm.animate.pose_droop_settle', 'robot_arm_poses', String(pose._id), { name: pose.name, reason, target, startedFrom, before: pose.trim ?? [], trim: stored, residual, rounds, done, history });
	return { trim, residual, rounds, done, startedFrom, warnings };
}

/** One settled pose, as the Pi's closed-loop replay reported it (replay_settle.py). */
export interface PiSettledPose {
	poseName: string;
	t: number;
	/** The droop trim learned from what the Pi had to write to land there. */
	trim: number[];
	/** Target − where the arm was on the Pi's last read. */
	residual: number[];
	rounds: number;
	/** Landed within tolerance before the hold ran out. */
	ok: boolean;
}

export interface SettleResult {
	poseName: string;
	droop: DroopResult | null;
	/** Set when the Pi settled the poses itself during the replay; BIMS then only learns from it. */
	pi: { poses: PiSettledPose[] } | null;
	/** Why nothing was done (the arm is left as the replay left it). */
	skipped: string | null;
}

/** How long to wait for the Pi's `replay.settle` webhook event after the session ends. */
const PI_SETTLE_WAIT_MS = 1000;
const PI_SETTLE_WAIT_TRIES = 3;

/**
 * The Pi's closed-loop replay (PRD §11) settles the arm on every held pose
 * and the last one, and reports each as a `replay.settle` run event. Learn
 * the poses' trims from it — no arm movement needed — or null when the run
 * has no such event (route not installed, or nothing was flagged).
 */
async function learnFromPiSettle(user: User, runId: string): Promise<PiSettledPose[] | null> {
	let ev: any = null;
	for (let i = 0; i < PI_SETTLE_WAIT_TRIES && !ev; i++) {
		if (i) await new Promise((r) => setTimeout(r, PI_SETTLE_WAIT_MS));
		const run = (await RobotArmRun.findOne({ runId }).select('events').lean()) as any;
		ev = run?.events?.find((e: any) => e?.type === 'replay.settle') ?? null;
	}
	const entries: any[] = Array.isArray(ev?.payload?.settle) ? ev.payload.settle : [];
	if (!entries.length) return null;
	const out: PiSettledPose[] = [];
	for (const e of entries) {
		const poseId = typeof e?.pose === 'string' ? e.pose : null;
		const trim = trimFromSettle(e?.written, e?.target);
		if (!poseId || !trim) continue;
		const pose = (await RobotArmPose.findById(poseId).lean()) as any;
		// Goal poses are never flagged; one edited into a goal pose since the play learns nothing.
		if (!pose || pose.basis === 'goal') continue;
		const stored = trim.some((v) => v !== 0) ? trim : [];
		await RobotArmPose.updateOne({ _id: poseId }, { $set: { trim: stored, trimMeasuredAt: new Date(), trimMeasuredBy: opRef(user) } });
		await audit(user, 'robot_arm.animate.pose_droop_from_replay', 'robot_arm_poses', poseId, { name: pose.name, runId, before: pose.trim ?? [], trim: stored, residual: e.residual, rounds: e.rounds, ok: !!e.ok, t: e.t });
		out.push({ poseName: pose.name, t: Number(e.t) || 0, trim, residual: Array.isArray(e.residual) ? e.residual.map(Number) : [], rounds: Number(e.rounds) || 0, ok: !!e.ok });
	}
	return out.length ? out : null;
}

export interface AfterPlayResult extends SettleResult {
	/** Torque was off when the play ended (older Pi replay) and was turned back on. */
	torqueRestored: boolean;
	torqueError: string | null;
	/** The arm right after, for the page's sliders and temperatures (null if it could not be read). */
	arm: ArmNow | null;
}

/**
 * Called by the page when a Play or Go to finished on its own (not stopped).
 * First, torque: a Pi replay without `hold_at_end` support writes torque OFF
 * at the end and the arm sags off the last pose — put it straight back on
 * (the last goal is the last frame, so it lifts back onto the pose). Then,
 * for a READING pose at the end only: if the Pi settled poses during the
 * replay, learn their trims from its report; else settle the arm onto the
 * target here and learn it. Goal poses need neither — they were played
 * exactly as set. Runs once per play.
 */
export async function afterPlay(user: User, runId: string): Promise<AfterPlayResult> {
	await connectDB();
	const base = { torqueRestored: false, torqueError: null as string | null, arm: null as ArmNow | null };
	// Torque first, whatever else happens: a limp arm is the worst end state.
	try {
		await requireIdle();
		const now = await readArm();
		if (now.torqueOn === false) {
			const t = await torqueBackOn();
			base.torqueRestored = t.ok;
			base.torqueError = t.ok ? null : t.error;
			await audit(user, 'robot_arm.animate.torque_after_play', 'robot_arm_runs', runId, { ok: t.ok, error: t.error, positions: now.positions });
			if (t.ok) await sleep(400);
		}
		base.arm = await readArm();
	} catch (err) {
		base.torqueError = (err as Error).message;
	}
	const q = { 'lastPlay.runId': runId, 'lastPlay.settledAt': null };
	const models = [RobotArmMoveSet, RobotArmSequence, RobotArmPose] as (typeof RobotArmMoveSet)[];
	let model: typeof RobotArmMoveSet | null = null;
	let doc: any = null;
	for (const m of models) {
		doc = await m.findOne(q).select('_id lastPlay').lean();
		if (doc) {
			model = m;
			break;
		}
	}
	const end = doc?.lastPlay?.end;
	if (!doc || !model || !end?.poseId || !Array.isArray(end.target)) return { ...base, poseName: '', droop: null, pi: null, skipped: 'nothing to settle for this play' };
	// Claim it first so a double call (two tabs, a retry) settles once.
	const claim = await model.updateOne({ _id: doc._id, 'lastPlay.runId': runId, 'lastPlay.settledAt': null }, { $set: { 'lastPlay.settledAt': new Date() } });
	if (!claim.modifiedCount) return { ...base, poseName: '', droop: null, pi: null, skipped: 'already settled' };
	const fromPi = await learnFromPiSettle(user, runId);
	if (fromPi) return { ...base, poseName: fromPi[fromPi.length - 1].poseName, droop: null, pi: { poses: fromPi }, skipped: null };
	const pose = (await RobotArmPose.findById(end.poseId).select('-lastPlay').lean()) as any;
	if (!pose) return { ...base, poseName: '', droop: null, pi: null, skipped: 'the last pose no longer exists' };
	if (pose.basis === 'goal') return { ...base, poseName: pose.name, droop: null, pi: null, skipped: null };
	try {
		await requireIdle();
		const now = base.arm ?? (await readArm());
		const droop = await settleAtPose(user, pose, end.target.map(Number), now, 'play_end');
		return { ...base, arm: await readArm().catch(() => base.arm), poseName: pose.name, droop, pi: null, skipped: null };
	} catch (err) {
		const skipped = (err as Error).message;
		await audit(user, 'robot_arm.animate.pose_droop_skip', 'robot_arm_poses', String(pose._id), { name: pose.name, reason: 'play_end', runId, skipped });
		return { ...base, poseName: pose.name, droop: null, pi: null, skipped };
	}
}

export async function clearPoseDroop(user: User, poseId: string): Promise<void> {
	await connectDB();
	const pose = (await RobotArmPose.findById(poseId).lean()) as any;
	if (!pose) throw new AnimateError('Pose not found.', 404);
	await RobotArmPose.updateOne({ _id: poseId }, { $set: { trim: [], trimMeasuredAt: null, trimMeasuredBy: null } });
	await audit(user, 'robot_arm.animate.pose_droop_clear', 'robot_arm_poses', poseId, { name: pose.name, before: pose.trim ?? [] });
}

// ── move sets ────────────────────────────────────────────────────────────

export interface MoveSetSummary {
	_id: string;
	name: string;
	notes: string | null;
	keyframes: Keyframe[];
	rateHz: number;
	archived: boolean;
	updatedAt: string | null;
	lastPlay: { at: string; by: { username?: string } | null; durationS: number | null } | null;
}

function moveSetSummary(d: any): MoveSetSummary {
	return {
		_id: String(d._id),
		name: d.name,
		notes: d.notes ?? null,
		keyframes: (d.keyframes ?? []).map((k: any): Keyframe => {
			if (k.fire?.solenoid) {
				return { poseId: '', holdS: Number(k.holdS ?? 0), durationS: 0, easing: 'linear', fire: { solenoid: k.fire.solenoid, pulseMs: Number(k.fire.pulseMs) } };
			}
			const out: Keyframe = { poseId: String(k.poseId), holdS: Number(k.holdS ?? 0), durationS: Number(k.durationS ?? 1), easing: isEasing(k.easing) ? k.easing : 'ease' };
			const offsets = cleanOffsets(k.offsets, MAX_OFFSET_STEPS);
			if (offsets) out.offsets = offsets;
			// Kept so the editor round-trips them (they were dropped here before 2026-10-28,
			// so a save from the editor cleared a step's verify / tolerances).
			if (k.verify === true || k.verify === false) out.verify = k.verify;
			if (k.tolerances) {
				const t = { positionMm: k.tolerances.positionMm ?? null, angleDeg: k.tolerances.angleDeg ?? null, steps: k.tolerances.steps ?? null };
				if (t.positionMm != null || t.angleDeg != null || t.steps != null) out.tolerances = t;
			}
			return out;
		}),
		rateHz: Number(d.rateHz) || DEFAULT_RATE_HZ,
		archived: !!d.archivedAt,
		updatedAt: d.updatedAt ? new Date(d.updatedAt).toISOString() : null,
		lastPlay: d.lastPlay?.at ? { at: new Date(d.lastPlay.at).toISOString(), by: d.lastPlay.by ?? null, durationS: d.lastPlay.durationS ?? null } : null
	};
}

export async function listMoveSets(): Promise<MoveSetSummary[]> {
	await connectDB();
	const rows = await RobotArmMoveSet.find({}).sort({ archivedAt: 1, updatedAt: -1 }).lean();
	return (rows as any[]).map(moveSetSummary);
}

export async function getMoveSet(id: string): Promise<MoveSetSummary | null> {
	await connectDB();
	const d = await RobotArmMoveSet.findById(id).lean();
	return d ? moveSetSummary(d) : null;
}

export async function createMoveSet(user: User, input: { name: unknown; notes?: unknown }): Promise<MoveSetSummary> {
	await connectDB();
	const name = cleanName(input.name, 'move set');
	const _id = generateId();
	await RobotArmMoveSet.create({ _id, name, notes: cleanNotes(input.notes), keyframes: [], rateHz: DEFAULT_RATE_HZ, createdBy: opRef(user), updatedBy: opRef(user) });
	await audit(user, 'robot_arm.animate.move_set_create', 'robot_arm_move_sets', _id, { name });
	return moveSetSummary(await RobotArmMoveSet.findById(_id).lean());
}

export async function updateMoveSet(user: User, id: string, input: { name: unknown; notes?: unknown; keyframes: unknown }): Promise<MoveSetSummary> {
	await connectDB();
	const before = (await RobotArmMoveSet.findById(id).lean()) as any;
	if (!before) throw new AnimateError('Move set not found.', 404);
	const name = cleanName(input.name, 'move set');
	let keyframes: Keyframe[];
	try {
		keyframes = cleanKeyframes(input.keyframes);
	} catch (e) {
		throw new AnimateError((e as Error).message);
	}
	const poseIds = [...new Set(keyframes.filter((k) => !k.fire).map((k) => k.poseId))];
	const found = await RobotArmPose.find({ _id: { $in: poseIds } }).select('_id').lean();
	if (found.length !== poseIds.length) throw new AnimateError('A keyframe refers to a pose that no longer exists — reload the page.');
	await RobotArmMoveSet.updateOne({ _id: id }, { $set: { name, notes: cleanNotes(input.notes), keyframes, updatedBy: opRef(user) } });
	const fires = keyframes.filter((k) => k.fire).map((k) => ({ solenoid: k.fire!.solenoid, pulseMs: k.fire!.pulseMs, waitS: k.holdS }));
	await audit(user, 'robot_arm.animate.move_set_update', 'robot_arm_move_sets', id, {
		name,
		keyframes: keyframes.length,
		...(fires.length ? { fires } : {}),
		before: { name: before.name, keyframes: before.keyframes?.length ?? 0 }
	});
	return moveSetSummary(await RobotArmMoveSet.findById(id).lean());
}

export async function setMoveSetArchived(user: User, id: string, archived: boolean): Promise<void> {
	await connectDB();
	const doc = (await RobotArmMoveSet.findById(id).lean()) as any;
	if (!doc) throw new AnimateError('Move set not found.', 404);
	await RobotArmMoveSet.updateOne({ _id: id }, { $set: { archivedAt: archived ? new Date() : null } });
	await audit(user, archived ? 'robot_arm.animate.move_set_archive' : 'robot_arm.animate.move_set_restore', 'robot_arm_move_sets', id, { name: doc.name });
}

/**
 * Keyframes with the positions the ARM is sent to: pose + the keyframe's
 * timeline offsets + the pose's droop trim — learned, or estimated from
 * nearby learned poses (`samples`) when this pose has not been settled yet.
 * `target` keeps where the arm should end up (without the trim). Everything
 * that resolves here goes to the Pi (play, save to Pi); the editors draw the
 * path without the trim. Archived poses still resolve.
 */
export function resolveKeyframes(keyframes: Keyframe[], poses: Map<string, PoseSummary>, samples: TrimSample[] = []): ResolvedKeyframe[] {
	const estimates = new Map<string, number[] | null>();
	// A fire step's positions are where the arm holds while it fires (the pose
	// before it; [] when it comes first — buildPath works that out from the arm).
	let here: number[] = [];
	return keyframes.map((k, i): ResolvedKeyframe => {
		if (k.fire) return { ...k, name: `Fire ${solenoidLabel(k.fire.solenoid)}`, positions: here };
		const r = resolvePoseKeyframe(k, i, poses, samples, estimates);
		here = r.positions;
		return r;
	});
}

function resolvePoseKeyframe(k: Keyframe, i: number, poses: Map<string, PoseSummary>, samples: TrimSample[], estimates: Map<string, number[] | null>): ResolvedKeyframe {
	const p = poses.get(k.poseId);
	if (!p) throw new AnimateError(`Keyframe ${i + 1} refers to a pose that no longer exists.`);
	// A goal pose is played exactly as set: no trim, and the Pi must not settle it.
	if (p.basis === 'goal') return { ...k, name: p.name, positions: keyframePositions(p.positions, k.offsets), settle: false };
	let trim = p.trim;
	if (!trim) {
		if (!estimates.has(p._id)) estimates.set(p._id, estimateTrim(p.positions, samples));
		trim = estimates.get(p._id) ?? null;
	}
	const target = keyframePositions(p.positions, k.offsets);
	const positions = keyframePositions(p.positions, k.offsets, trim);
	return { ...k, name: p.name, positions, ...(trim ? { target } : {}) };
}

async function posesById(ids: string[]): Promise<Map<string, PoseSummary>> {
	const rows = await RobotArmPose.find({ _id: { $in: [...new Set(ids)] } }).select('-lastPlay').lean();
	return new Map((rows as any[]).map((d) => [String(d._id), poseSummary(d)]));
}

export async function resolveMoveSet(id: string): Promise<{ summary: MoveSetSummary; keyframes: ResolvedKeyframe[] }> {
	const summary = await getMoveSet(id);
	if (!summary) throw new AnimateError('Move set not found.', 404);
	const [poses, samples] = await Promise.all([posesById(summary.keyframes.filter((k) => !k.fire).map((k) => k.poseId)), trimSamples()]);
	return { summary, keyframes: resolveKeyframes(summary.keyframes, poses, samples) };
}

// ── sequences ────────────────────────────────────────────────────────────

export interface SequenceItemRecord {
	moveSetId: string;
	joinDurationS: number | null;
	joinEasing: Easing;
}

export interface SequenceSummary {
	_id: string;
	name: string;
	notes: string | null;
	items: SequenceItemRecord[];
	archived: boolean;
	updatedAt: string | null;
	lastPlay: { at: string; by: { username?: string } | null; durationS: number | null } | null;
	savedAs: { name: string; at: string; by: { username?: string } | null; frames: number; durationS: number }[];
}

function sequenceSummary(d: any): SequenceSummary {
	return {
		_id: String(d._id),
		name: d.name,
		notes: d.notes ?? null,
		items: (d.items ?? []).map((it: any): SequenceItemRecord => ({
			moveSetId: String(it.moveSetId),
			joinDurationS: Number.isFinite(it.joinDurationS) ? Number(it.joinDurationS) : null,
			joinEasing: isEasing(it.joinEasing) ? it.joinEasing : 'ease'
		})),
		archived: !!d.archivedAt,
		updatedAt: d.updatedAt ? new Date(d.updatedAt).toISOString() : null,
		lastPlay: d.lastPlay?.at ? { at: new Date(d.lastPlay.at).toISOString(), by: d.lastPlay.by ?? null, durationS: d.lastPlay.durationS ?? null } : null,
		savedAs: (d.savedAs ?? []).map((s: any) => ({ name: s.name, at: new Date(s.at).toISOString(), by: s.by ?? null, frames: s.frames, durationS: s.durationS }))
	};
}

export async function listSequences(): Promise<SequenceSummary[]> {
	await connectDB();
	const rows = await RobotArmSequence.find({}).sort({ archivedAt: 1, updatedAt: -1 }).lean();
	return (rows as any[]).map(sequenceSummary);
}

export async function getSequence(id: string): Promise<SequenceSummary | null> {
	await connectDB();
	const d = await RobotArmSequence.findById(id).lean();
	return d ? sequenceSummary(d) : null;
}

export async function createSequence(user: User, input: { name: unknown; notes?: unknown }): Promise<SequenceSummary> {
	await connectDB();
	const name = cleanName(input.name, 'sequence');
	const _id = generateId();
	await RobotArmSequence.create({ _id, name, notes: cleanNotes(input.notes), items: [], createdBy: opRef(user), updatedBy: opRef(user) });
	await audit(user, 'robot_arm.animate.sequence_create', 'robot_arm_sequences', _id, { name });
	return sequenceSummary(await RobotArmSequence.findById(_id).lean());
}

function cleanItems(input: unknown): SequenceItemRecord[] {
	if (!Array.isArray(input)) throw new AnimateError('items must be a list');
	if (input.length > 100) throw new AnimateError('at most 100 move sets in a sequence');
	return input.map((it: any, i) => {
		const moveSetId = String(it?.moveSetId ?? '').trim();
		if (!moveSetId) throw new AnimateError(`item ${i + 1}: no move set`);
		const raw = it?.joinDurationS;
		let joinDurationS: number | null = null;
		if (raw != null && raw !== '') {
			const n = Number(raw);
			if (!Number.isFinite(n) || n < MIN_TRANSITION_S || n > MAX_TRANSITION_S) throw new AnimateError(`item ${i + 1}: join must be ${MIN_TRANSITION_S}–${MAX_TRANSITION_S} s or automatic`);
			joinDurationS = Math.round(n * 10) / 10;
		}
		return { moveSetId, joinDurationS, joinEasing: isEasing(it?.joinEasing) ? it.joinEasing : 'ease' };
	});
}

export async function updateSequence(user: User, id: string, input: { name: unknown; notes?: unknown; items: unknown }): Promise<SequenceSummary> {
	await connectDB();
	const before = (await RobotArmSequence.findById(id).lean()) as any;
	if (!before) throw new AnimateError('Sequence not found.', 404);
	const name = cleanName(input.name, 'sequence');
	const items = cleanItems(input.items);
	const ids = [...new Set(items.map((i) => i.moveSetId))];
	const found = await RobotArmMoveSet.find({ _id: { $in: ids } }).select('_id').lean();
	if (found.length !== ids.length) throw new AnimateError('An item refers to a move set that no longer exists — reload the page.');
	await RobotArmSequence.updateOne({ _id: id }, { $set: { name, notes: cleanNotes(input.notes), items, updatedBy: opRef(user) } });
	await audit(user, 'robot_arm.animate.sequence_update', 'robot_arm_sequences', id, { name, items: items.length, before: { name: before.name, items: before.items?.length ?? 0 } });
	return sequenceSummary(await RobotArmSequence.findById(id).lean());
}

export async function setSequenceArchived(user: User, id: string, archived: boolean): Promise<void> {
	await connectDB();
	const doc = (await RobotArmSequence.findById(id).lean()) as any;
	if (!doc) throw new AnimateError('Sequence not found.', 404);
	await RobotArmSequence.updateOne({ _id: id }, { $set: { archivedAt: archived ? new Date() : null } });
	await audit(user, archived ? 'robot_arm.animate.sequence_archive' : 'robot_arm.animate.sequence_restore', 'robot_arm_sequences', id, { name: doc.name });
}

/** The sequence as one keyframe list (joins included). */
export async function resolveSequence(id: string): Promise<{ summary: SequenceSummary; keyframes: ResolvedKeyframe[]; items: SequenceItem[] }> {
	const summary = await getSequence(id);
	if (!summary) throw new AnimateError('Sequence not found.', 404);
	const sets = (await RobotArmMoveSet.find({ _id: { $in: summary.items.map((i) => i.moveSetId) } }).lean()) as any[];
	const byId = new Map(sets.map((d) => [String(d._id), moveSetSummary(d)]));
	const [poses, samples] = await Promise.all([posesById(sets.flatMap((d) => (d.keyframes ?? []).map((k: any) => String(k.poseId ?? '')).filter(Boolean))), trimSamples()]);
	const items: SequenceItem[] = summary.items.map((it, i) => {
		const ms = byId.get(it.moveSetId);
		if (!ms) throw new AnimateError(`Item ${i + 1} refers to a move set that no longer exists.`);
		return { name: ms.name, keyframes: resolveKeyframes(ms.keyframes, poses, samples), join: { durationS: it.joinDurationS, easing: it.joinEasing } };
	});
	return { summary, keyframes: flattenSequence(items), items };
}

// ── playback ─────────────────────────────────────────────────────────────

export interface PlayResult {
	runId: string;
	/** Whole path including the lead-in, seconds. */
	durationS: number;
	leadInS: number;
	frames: number;
	warnings: string[];
}

function render(keyframes: ResolvedKeyframe[], from: number[] | null, rateHz: number): RenderedPath {
	try {
		return buildPath(keyframes, { rateHz, leadIn: from ? { from } : null });
	} catch (e) {
		throw new AnimateError((e as Error).message);
	}
}

export type PlayKind = 'move_set' | 'sequence' | 'pose';
const PLAY_MODEL = { move_set: RobotArmMoveSet, sequence: RobotArmSequence, pose: RobotArmPose } as Record<PlayKind, typeof RobotArmMoveSet>;
const PLAY_TABLE: Record<PlayKind, string> = { move_set: 'robot_arm_move_sets', sequence: 'robot_arm_sequences', pose: 'robot_arm_poses' };

/**
 * Render `keyframes` from where the arm is, write the path to the Pi and
 * start the replay. Play, Go to pose and (ARM-09) each chunk of a verified
 * run come through here. `lastPlay: false` leaves the source record's
 * lastPlay alone (a verified run keeps its own record and never settles).
 */
export async function writeAndPlay(
	user: User,
	o: { title: string; keyframes: ResolvedKeyframe[]; rateHz: number; kind: PlayKind; id: string; lastPlay?: boolean; auditAction?: string; auditExtra?: Record<string, unknown> }
): Promise<PlayResult> {
	if (!o.keyframes.length) throw new AnimateError('Nothing to play — add poses first.');
	await requireIdle();
	const fireSteps = o.keyframes.filter((k) => k.fire);
	const gpio = fireSteps.length ? await requireReplayFire() : null;
	const now = await readArm();
	if (now.torqueOn === false) throw new AnimateError('Torque is off — press Torque on first.', 409);
	const warnings: string[] = requireCool(now);
	if (gpio?.simulated) warnings.push('The Pi has no GPIO right now (simulated): the fire steps are timed but nothing is driven.');
	const path = render(o.keyframes, now.positions, o.rateHz);
	const stats = pathStats(path);
	if (stats.tooFast.length) throw new AnimateError(`Servo(s) ${stats.tooFast.join(', ')} would move faster than the arm can — lengthen the transitions marked too fast.`);
	for (const p of tooFast(o.keyframes)) warnings.push(p.message);
	const leadInS = path.markers[0]?.kind === 'lead-in' ? (path.markers[1]?.t ?? 0) : 0;
	const out = composeAnimationJsonl(path, { jointNames: DEFAULT_JOINT_NAMES, title: o.title, extras: { animate_kind: o.kind, animate_id: o.id, operator: user.username } });
	const meta: RecordingSidecar & Record<string, unknown> = {
		schema_version: 1,
		frame_count: out.frames,
		operator: user.username,
		started_at_iso: new Date().toISOString(),
		rate_hz: o.rateHz,
		animated: o.title
	};
	// Overwrite the scratch recording: the Pi refuses a restore onto an existing name.
	try {
		await robotArm.deleteRecording(PREVIEW_RECORDING);
	} catch (err) {
		if (!/robot-arm 404/.test((err as Error).message ?? '')) throw new AnimateError(`Could not clear the preview recording on the Pi: ${(err as Error).message}`, 502);
	}
	try {
		await robotArm.restoreRecording({ name: PREVIEW_RECORDING, jsonl: out.jsonl, meta });
	} catch (err) {
		throw new AnimateError(`The Pi did not take the path: ${(err as Error).message}`, 502);
	}
	// Replay by the absolute path the Pi lists, exactly as the Control tab does:
	// the live Pi's replay does not find a restored recording by bare name
	// (seen 2026-10-21: "400: recording not found: animate-preview").
	const source = await recordingPath(PREVIEW_RECORDING);
	let runId: string;
	try {
		// The path starts where the arm is, so preflight (±50 steps of frame 0) passes by construction.
		const started = await robotArm.startReplay({ source, loops: 1, triggered_by: opRef(user), enforce_preflight: true, preflight_tolerance_steps: 50 });
		runId = started.run_id;
	} catch (err) {
		const msg = (err as Error).message ?? String(err);
		throw new AnimateError(msg.includes('409') ? `The Pi refused to start: ${msg}` : `Replay did not start: ${msg}`, 502);
	}
	// Where the play leaves the arm, so the page can settle it there afterwards
	// (afterPlay): the last pose — fire steps after it do not move the arm.
	const last = [...o.keyframes].reverse().find((k) => !k.fire);
	const end = last ? { poseId: last.poseId, target: last.target ?? last.positions } : { poseId: '', target: [] as number[] };
	if (o.lastPlay !== false) await PLAY_MODEL[o.kind].updateOne({ _id: o.id }, { $set: { lastPlay: { at: new Date(), by: opRef(user), runId, durationS: path.durationS, end, settledAt: null } } });
	await audit(user, o.auditAction ?? (o.kind === 'pose' ? 'robot_arm.animate.go_to_pose' : `robot_arm.animate.play_${o.kind}`), PLAY_TABLE[o.kind], o.id, {
		...(o.auditExtra ?? {}),
		runId,
		durationS: path.durationS,
		leadInS,
		frames: out.frames,
		from: now.positions,
		temps: now.temps,
		maxStepsPerS: stats.maxStepsPerS,
		...(out.fires ? { fires: fireFrames(path).map((f) => ({ t: f.t, solenoid: f.solenoid, pin: f.pin, ms: f.ms })), gpioSimulated: !!gpio?.simulated } : {})
	});
	return { runId, durationS: path.durationS, leadInS, frames: out.frames, warnings };
}

/**
 * A path with fire steps plays only on a Pi whose replay fires them: an older
 * replay would ignore the `fire` frames and play the arm without a single
 * trapdoor opening, which is worse than refusing. replay_fire comes from
 * GET /gpio/status (services/robot-arm gpio.py, set by replay_settle.install).
 */
async function requireReplayFire(): Promise<{ simulated: boolean }> {
	let s: { replay_fire?: boolean; simulated?: boolean };
	try {
		s = await robotArm.gpioStatus();
	} catch (err) {
		const msg = (err as Error).message ?? String(err);
		if (/robot-arm 404/.test(msg)) throw new AnimateError('This move set fires solenoids, but the arm Pi has no GPIO routes. Install the solenoid module on the Pi first.', 409);
		throw new AnimateError(`Could not check the Pi's solenoids before playing: ${msg}`, 502);
	}
	if (!s.replay_fire) throw new AnimateError("This move set fires solenoids, but the arm Pi's replay cannot fire them yet. Update replay_settle.py and gpio.py on the Pi and restart robot-arm.", 409);
	return { simulated: !!s.simulated };
}

/** Solenoid status for the Animate pages (null when the Pi or its GPIO routes are not there). */
export async function solenoidStatus(): Promise<SolenoidStatus | null> {
	try {
		const s = await robotArm.gpioStatus();
		return { pins: s.pins ?? {}, simulated: !!s.simulated, busy: !!s.busy, replayFire: !!s.replay_fire };
	} catch {
		return null;
	}
}

/**
 * Test fire one solenoid from the Animate pages (the editor's Test fire, the
 * Solenoids card). Same Pi route and audit table as the Control tab's buttons.
 * Allowed while the arm plays, like the Control tab: the Pi's lock still
 * refuses a pulse while another is on, so both trapdoors never open at once.
 */
export async function testFire(user: User, solenoid: Solenoid, pulseMs: number): Promise<{ simulated: boolean; elapsedMs: number }> {
	if (!Number.isFinite(pulseMs) || pulseMs < MIN_PULSE_MS || pulseMs > MAX_PULSE_MS) throw new AnimateError(`The pulse must be ${MIN_PULSE_MS}–${MAX_PULSE_MS} ms.`);
	const pin = solenoidPin(solenoid);
	let r;
	try {
		r = await robotArm.pulseGpio({ pin, ms: Math.round(pulseMs) });
	} catch (err) {
		const msg = (err as Error).message ?? String(err);
		if (/robot-arm 409/.test(msg)) throw new AnimateError('A solenoid is already firing on the Pi — wait for it to finish.', 409);
		if (/robot-arm 404/.test(msg)) throw new AnimateError('The arm Pi has no GPIO routes yet.', 409);
		throw new AnimateError(`Fire failed: ${msg}`, 502);
	}
	await connectDB();
	await AuditLog.create({
		_id: generateId(),
		tableName: 'robot_arm_gpio',
		recordId: 'robot-arm-pi',
		action: 'robot_arm.gpio.pulse',
		newData: { pin, solenoid, ms: Math.round(pulseMs), simulated: r.simulated, from: 'animate', userId: user._id },
		changedBy: user.username
	});
	return { simulated: !!r.simulated, elapsedMs: r.elapsed_ms ?? Math.round(pulseMs) };
}

/** The Pi's absolute path for a recording it just accepted; a clear error when it cannot see it. */
async function recordingPath(name: string): Promise<string> {
	let recordings;
	try {
		recordings = (await robotArm.listRecordings()).recordings ?? [];
	} catch (err) {
		throw new AnimateError(`Could not list the Pi's recordings after writing the path: ${(err as Error).message}`, 502);
	}
	const rec = recordings.find((r) => recordingStem(r.name) === name);
	if (!rec?.path) {
		throw new AnimateError(
			`The Pi accepted "${name}" but does not list it among its recordings — its restore route is saving to a different folder than replay reads. On arm-pi, check BIMS_ARM_RECORDINGS_DIR for the service and recordings_admin.py.`,
			502
		);
	}
	return rec.path;
}

/** Play a move set from wherever the arm is now. The arm MOVES. */
export async function playMoveSet(user: User, id: string): Promise<PlayResult> {
	const { summary, keyframes } = await resolveMoveSet(id);
	return writeAndPlay(user, { title: summary.name, keyframes, rateHz: summary.rateHz, kind: 'move_set', id });
}

/** Play a whole sequence from wherever the arm is now. The arm MOVES. */
export async function playSequence(user: User, id: string): Promise<PlayResult> {
	const { summary, keyframes } = await resolveSequence(id);
	return writeAndPlay(user, { title: summary.name, keyframes, rateHz: DEFAULT_RATE_HZ, kind: 'sequence', id });
}

export interface StopResult {
	stoppedRunId: string | null;
	torqueOn: boolean;
	error: string | null;
}

/** Stop whatever is playing and leave the arm holding where it is (torque on, one retry). */
export async function stopPlayback(user: User): Promise<StopResult> {
	await connectDB();
	let stoppedRunId: string | null = null;
	try {
		stoppedRunId = (await robotArm.stop()).stopped_run_id ?? null;
	} catch (err) {
		throw new AnimateError(`Stop failed: ${(err as Error).message}`, 502);
	}
	let torqueOn = false;
	let error: string | null = null;
	for (let i = 0; i < 2 && !torqueOn; i++) {
		if (i) await new Promise((r) => setTimeout(r, 600));
		try {
			await robotArm.setTorque(true);
			torqueOn = true;
		} catch (e) {
			error = (e as Error).message;
		}
	}
	await audit(user, 'robot_arm.animate.stop', 'robot_arm_runs', stoppedRunId ?? 'none', { torqueOn, error });
	return { stoppedRunId, torqueOn, error: torqueOn ? null : error };
}

export async function playbackActive(): Promise<{ runId: string; kind: string } | null> {
	const a = (await robotArm.getActive()).active;
	return a ? { runId: a.run_id, kind: a.kind } : null;
}

// ── save to Pi ───────────────────────────────────────────────────────────

/**
 * Write a move set or sequence to the Pi as a named recording (no lead-in:
 * it starts at the first pose, so Control's replay preflight asks the arm
 * to be there first). Usable from the Control tab and in tasks.
 */
export async function saveToPi(user: User, kind: 'move_set' | 'sequence', id: string, rawName: unknown): Promise<{ name: string; frames: number; durationS: number }> {
	const name = cleanAnimationName(String(rawName ?? ''));
	if (!name) throw new AnimateError('Name: letters, numbers, spaces, - _ . only (max 100).');
	const r = kind === 'move_set' ? await resolveMoveSet(id) : await resolveSequence(id);
	if (!r.keyframes.length) throw new AnimateError('Nothing to save — add poses first.');
	const rateHz = kind === 'move_set' ? (r.summary as MoveSetSummary).rateHz : DEFAULT_RATE_HZ;
	const path = render(r.keyframes, null, rateHz);
	const stats = pathStats(path);
	if (stats.tooFast.length) throw new AnimateError(`Servo(s) ${stats.tooFast.join(', ')} would move faster than the arm can — lengthen the transitions marked too fast.`);
	const out = composeAnimationJsonl(path, { jointNames: DEFAULT_JOINT_NAMES, title: r.summary.name, extras: { animate_kind: kind, animate_id: id, operator: user.username } });
	const now = new Date();
	const meta: RecordingSidecar & Record<string, unknown> = { schema_version: 1, frame_count: out.frames, operator: user.username, started_at_iso: now.toISOString(), rate_hz: rateHz, animated: r.summary.name };
	try {
		await robotArm.restoreRecording({ name, jsonl: out.jsonl, meta });
	} catch (err) {
		const msg = (err as Error).message ?? '';
		if (msg.includes('robot-arm 409')) throw new AnimateError(`"${name}" already exists on the Pi. Pick another name.`, 409);
		throw new AnimateError(`The Pi did not take the recording: ${msg}`, 502);
	}
	const entry = { name: `${name}.jsonl`, at: now, by: opRef(user), frames: out.frames, durationS: out.durationS };
	if (kind === 'sequence') await RobotArmSequence.updateOne({ _id: id }, { $push: { savedAs: entry } });
	await audit(user, `robot_arm.animate.save_to_pi`, kind === 'move_set' ? 'robot_arm_move_sets' : 'robot_arm_sequences', id, { ...entry, kind });
	return { name: entry.name, frames: out.frames, durationS: out.durationS };
}

/** For the editors: the automatic join length between two poses. */
export { autoDurationS };
