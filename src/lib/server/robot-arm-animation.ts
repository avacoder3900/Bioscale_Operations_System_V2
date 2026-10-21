/**
 * Robot arm — pose animation (ARM-06 Animate): the I/O half.
 *
 * Pure decisions live in $lib/robot-arm/animation (easing, path rendering,
 * sequence flattening, the Pi's recording format), unit-tested. This module
 * owns the pose / move-set / sequence records, the two capture flows (with
 * the control arm, or by hand), and playback: render the path from where
 * the arm is now, write it to the Pi as a scratch recording, start a replay.
 *
 * Pi calls:
 *   GET  /servos                 follower positions + torque state
 *   POST /teleop/start           follower tracks the control (leader) arm under torque
 *   POST /sessions/stop          pause/stop that (the follower holds its last goal)
 *   POST /torque                 torque OFF so the operator can pose by hand
 *   POST /servos/hold            goal := present, torque ON (no jump) — hold.py
 *   POST /servos/{id}/jog        go to a pose (≤300 steps per jog); measure a pose's droop
 *   POST /recordings/restore     write the rendered path
 *   POST /replay/start           play it;  POST /sessions/stop  stop
 */
import { connectDB, AuditLog, generateId } from '$lib/server/db';
import { RobotArmMoveSet, RobotArmPose, RobotArmSequence } from '$lib/server/db/models';
import { robotArm, type RecordingSidecar, type ServoState } from './robot-arm-client';
import { DEFAULT_JOINT_NAMES } from '$lib/robot-arm/recording-cleanup';
import {
	autoDurationS,
	buildPath,
	cleanAnimationName,
	cleanKeyframes,
	cleanOffsets,
	estimateTrim,
	composeAnimationJsonl,
	flattenSequence,
	isEasing,
	keyframePositions,
	nextTrim,
	pathStats,
	tooFast,
	DEFAULT_RATE_HZ,
	MAX_OFFSET_STEPS,
	MAX_TRANSITION_S,
	MAX_TRIM_STEPS,
	MIN_TRANSITION_S,
	SERVO_COUNT,
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

/** Scratch recording every Play writes on the Pi (overwritten each time). */
export const PREVIEW_RECORDING = 'animate-preview';
/** The Pi caps one jog at 300 steps. */
const JOG_CHUNK = 300;
/** Go-to-pose refuses bigger per-servo moves. */
const MAX_GOTO_STEPS = 1500;
const GOTO_DEADBAND = 3;

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
	/** All six torque-on; null when the Pi does not report it. */
	torqueOn: boolean | null;
	servos: ServoState[];
}

function servoMessage(err: unknown): string {
	const msg = (err as Error).message ?? String(err);
	if (/robot-arm 404/.test(msg)) return 'The Pi has no GET /servos route yet (services/robot-arm/scripts/install_servos_route.py).';
	return msg;
}

/** Follower positions (servo 1..6) and torque state. Read-only, no session needed. */
export async function readArm(): Promise<ArmNow> {
	let servos: ServoState[];
	try {
		servos = await robotArm.listServos();
	} catch (err) {
		throw new AnimateError(`Could not read the follower: ${servoMessage(err)}`, 502);
	}
	if (!Array.isArray(servos) || !servos.length) throw new AnimateError('The follower reported no servos.', 502);
	const positions: number[] = [];
	for (let sid = 1; sid <= SERVO_COUNT; sid++) {
		const s = servos.find((x) => x?.id === sid);
		if (!s || !Number.isFinite(s.position)) throw new AnimateError(`Servo ${sid} did not report a position.`, 502);
		positions.push(Math.round(s.position));
	}
	const torques = servos.filter((s) => s.id >= 1 && s.id <= SERVO_COUNT).map((s) => s.torque);
	const torqueOn = torques.every((t) => typeof t === 'boolean') ? torques.every(Boolean) : null;
	return { positions, torqueOn, servos };
}

async function requireIdle() {
	let active;
	try {
		active = (await robotArm.getActive()).active;
	} catch (err) {
		throw new AnimateError(`Cannot reach the arm: ${(err as Error).message}`, 502);
	}
	if (active) throw new AnimateError(`A ${active.kind} session is using the arm. Stop it first.`, 409);
}

/**
 * Pose by hand: drop torque so the operator can move the follower. The arm
 * sags — the operator supports it. Ends with savePoseFromArm or holdArm.
 */
export async function poseByHand(user: User): Promise<ArmNow> {
	await connectDB();
	await requireIdle();
	const before = await readArm();
	await robotArm.setTorque(false);
	await audit(user, 'robot_arm.animate.pose_by_hand', 'robot_arm_poses', 'arm', { positions: before.positions });
	return { ...before, torqueOn: false };
}

export interface HoldResult {
	held: boolean;
	/** Why torque is still off, when it is. */
	error: string | null;
}

/**
 * Torque back on where the arm is, with no jump. Needs the Pi's hold route;
 * without it, torque stays OFF (a bare torque-on would throw the arm back to
 * its last goal) and the operator is told what to install.
 */
export async function holdArm(user: User): Promise<HoldResult> {
	await connectDB();
	try {
		const r = await robotArm.holdServos();
		await audit(user, 'robot_arm.animate.hold', 'robot_arm_poses', 'arm', { positions: r.positions });
		return { held: !!r.held, error: r.held ? null : 'The Pi did not confirm the hold.' };
	} catch (err) {
		const msg = (err as Error).message ?? String(err);
		const error = /robot-arm 404/.test(msg)
			? 'The Pi has no POST /servos/hold route yet (services/robot-arm/scripts/install_hold_router.py). Torque is still OFF — support the arm; do not re-enable torque from the Control tab unless the arm is back where it was.'
			: `Torque is still OFF: ${msg}`;
		await audit(user, 'robot_arm.animate.hold_failed', 'robot_arm_poses', 'arm', { error });
		return { held: false, error };
	}
}

// ── pose with the control (leader) arm ───────────────────────────────────
//
// Posing by hand needs torque OFF, so the follower sags under its own weight
// and the encoders read the sagged position, not the one the operator meant;
// and torque-on afterwards needs the hold route or the arm jumps. Posing with
// the control arm avoids both: a teleop session snaps the follower's goal to
// where it is, turns torque ON and then drives it to wherever the leader is,
// so the follower is always powered and always where the operator put it.

/** Stamped on the teleop runs the Animate tab starts, so the Runs tab can tell them apart. */
export const LEADER_POSING_STEP = 'animate-pose';
/** Teleop rate while posing; the follower only has to keep up with a hand. */
const LEADER_POSING_RATE_HZ = 30;
/** After a teleop stop the follower is still settling on its last goal; wait before reading it. */
const SETTLE_MS = 400;

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
	return startTeleopForPosing(user, 'start');
}

export interface LeaderPoseResult {
	pose: PoseSummary;
	/** The follower is following the control arm again (a new teleop run). */
	resumed: boolean;
	runId: string | null;
	/** Why it is not following, when it is not. The follower holds the pose under torque either way. */
	warning: string | null;
}

/**
 * Save the follower's position while posing with the control arm. The Pi's
 * driver is not thread-safe and the teleop thread owns the bus, so the bus
 * is never read mid-session: stop the session (the follower keeps torque and
 * its last goal, so it holds the pose), let it settle, read it, save, then
 * start a fresh teleop so the operator can carry on to the next pose.
 */
export async function savePoseFromLeader(user: User, input: { name: unknown; notes?: unknown; resume: boolean }): Promise<LeaderPoseResult> {
	await connectDB();
	const name = cleanName(input.name, 'pose');
	await assertPoseNameFree(name);
	const posing = await leaderPosingActive();
	if (!posing) throw new AnimateError('The follower is not following the control arm — press "Pose with the control arm" first.', 409);
	try {
		await robotArm.stop();
	} catch (err) {
		throw new AnimateError(`Could not pause the control arm: ${(err as Error).message}`, 502);
	}
	await new Promise((r) => setTimeout(r, SETTLE_MS));
	const now = await readArm();
	const _id = generateId();
	await RobotArmPose.create({ _id, name, positions: now.positions, notes: cleanNotes(input.notes), createdBy: opRef(user) });
	await audit(user, 'robot_arm.animate.pose_save', 'robot_arm_poses', _id, {
		name,
		positions: now.positions,
		torqueOnAtCapture: now.torqueOn,
		source: 'leader',
		pausedRunId: posing.runId
	});
	let warning: string | null =
		now.torqueOn === false ? 'The follower reports torque OFF, so it may not be holding the pose — press Hold (torque on) before moving on.' : null;
	let resumed = false;
	let runId: string | null = null;
	if (input.resume) {
		try {
			runId = (await startTeleopForPosing(user, 'after pose_save')).runId;
			resumed = true;
		} catch (err) {
			warning = [warning, `Saved, but the follower is no longer following the control arm: ${(err as Error).message} It is holding where it is.`]
				.filter(Boolean)
				.join(' ');
		}
	}
	return { pose: poseSummary(await RobotArmPose.findById(_id).lean()), resumed, runId, warning };
}

/** Done posing: stop the teleop session. The follower keeps torque and holds its last goal; the leader stays limp. */
export async function stopLeaderPosing(user: User): Promise<{ stoppedRunId: string | null }> {
	await connectDB();
	const posing = await leaderPosingActive();
	if (!posing) return { stoppedRunId: null };
	let stoppedRunId: string | null;
	try {
		stoppedRunId = (await robotArm.stop()).stopped_run_id ?? null;
	} catch (err) {
		throw new AnimateError(`Stop failed: ${(err as Error).message}`, 502);
	}
	await audit(user, 'robot_arm.animate.leader_posing_stop', 'robot_arm_poses', 'arm', { runId: stoppedRunId });
	return { stoppedRunId };
}

// ── poses ────────────────────────────────────────────────────────────────

export interface PoseSummary {
	_id: string;
	name: string;
	positions: number[];
	/** Droop trim added to the goal when played (six entries), or null if never measured. */
	trim: number[] | null;
	trimMeasuredAt: string | null;
	notes: string | null;
	archived: boolean;
	createdAt: string | null;
	createdBy: { username?: string } | null;
}

function poseSummary(d: any): PoseSummary {
	const trim = Array.isArray(d.trim) && d.trim.length === SERVO_COUNT ? d.trim.map(Number) : null;
	return {
		_id: String(d._id),
		name: d.name,
		positions: (d.positions ?? []).map(Number),
		trim,
		trimMeasuredAt: d.trimMeasuredAt ? new Date(d.trimMeasuredAt).toISOString() : null,
		notes: d.notes ?? null,
		archived: !!d.archivedAt,
		createdAt: d.createdAt ? new Date(d.createdAt).toISOString() : null,
		createdBy: d.createdBy ?? null
	};
}

export async function listPoses(): Promise<PoseSummary[]> {
	await connectDB();
	const rows = await RobotArmPose.find({}).sort({ archivedAt: 1, createdAt: -1 }).lean();
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

/**
 * Save the follower's current position as a pose, then (when `hold`) bring
 * torque back on without a jump. The pose is saved even if the hold fails —
 * the arm is still in it.
 */
export async function savePoseFromArm(user: User, input: { name: unknown; notes?: unknown; hold: boolean }): Promise<{ pose: PoseSummary; hold: HoldResult | null }> {
	await connectDB();
	const name = cleanName(input.name, 'pose');
	await assertPoseNameFree(name);
	const now = await readArm();
	const _id = generateId();
	await RobotArmPose.create({ _id, name, positions: now.positions, notes: cleanNotes(input.notes), createdBy: opRef(user) });
	await audit(user, 'robot_arm.animate.pose_save', 'robot_arm_poses', _id, { name, positions: now.positions, torqueOnAtCapture: now.torqueOn });
	const hold = input.hold ? await holdArm(user) : null;
	const doc = await RobotArmPose.findById(_id).lean();
	return { pose: poseSummary(doc), hold };
}

export async function updatePose(user: User, id: string, input: { name: unknown; notes?: unknown; fromArm?: boolean }): Promise<PoseSummary> {
	await connectDB();
	const before = (await RobotArmPose.findById(id).lean()) as any;
	if (!before) throw new AnimateError('Pose not found.', 404);
	const name = cleanName(input.name, 'pose');
	await assertPoseNameFree(name, id);
	const set: Record<string, unknown> = { name, notes: cleanNotes(input.notes) };
	if (input.fromArm) {
		set.positions = (await readArm()).positions;
		// A droop trim was measured at the old position; it no longer applies.
		Object.assign(set, { trim: [], trimMeasuredAt: null, trimMeasuredBy: null });
	}
	await RobotArmPose.updateOne({ _id: id }, { $set: set });
	await audit(user, 'robot_arm.animate.pose_update', 'robot_arm_poses', id, { before: { name: before.name, notes: before.notes, positions: before.positions }, after: set });
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

export interface GoToResult {
	before: number[];
	after: number[];
	jogs: number;
	/** Target − where each servo ended up. */
	residual: number[];
	/** The automatic droop settle at the end (null if it could not run — see warnings). */
	droop: DroopResult | null;
	warnings: string[];
}

/**
 * Drive the follower to a pose with per-joint jogs (≤300 steps each, servos
 * in id order so the gripper goes last), then settle it ON the pose: the
 * automatic droop pass (settleAtPose) corrects servos 1–5 for gravity and
 * learns the pose's trim as it does. Torque must be on. The arm MOVES.
 */
export async function goToPose(user: User, poseId: string): Promise<GoToResult> {
	await connectDB();
	const pose = (await RobotArmPose.findById(poseId).lean()) as any;
	if (!pose) throw new AnimateError('Pose not found.', 404);
	const target: number[] = pose.positions.map(Number);
	await requireIdle();
	const start = await readArm();
	if (start.torqueOn === false) throw new AnimateError('Torque is off — press Hold (torque on) first.', 409);
	for (let i = 0; i < SERVO_COUNT; i++) {
		if (Math.abs(target[i] - start.positions[i]) > MAX_GOTO_STEPS) {
			throw new AnimateError(`Servo ${i + 1} would move ${target[i] - start.positions[i]} steps (more than ${MAX_GOTO_STEPS}). Bring the arm closer with Jog first.`);
		}
	}
	let jogs = 0;
	const jogToward = async (from: number[], servos: number[]) => {
		for (const sid of servos) {
			const i = sid - 1;
			let remaining = target[i] - from[i];
			while (Math.abs(remaining) > GOTO_DEADBAND) {
				const chunk = Math.max(-JOG_CHUNK, Math.min(JOG_CHUNK, remaining));
				try {
					await robotArm.jogJoint(sid, chunk);
				} catch (err) {
					throw new AnimateError(`Servo ${sid} jog failed after ${jogs} jogs: ${(err as Error).message}`, 502);
				}
				jogs++;
				remaining -= chunk;
			}
		}
	};
	const all = Array.from({ length: SERVO_COUNT }, (_, i) => i + 1);
	await jogToward(start.positions, all);
	await new Promise((r) => setTimeout(r, 600));
	let now = await readArm();
	const warnings: string[] = [];
	let droop: DroopResult | null = null;
	try {
		droop = await settleAtPose(user, pose, target, now, 'go_to');
		now = await readArm();
		warnings.push(...droop.warnings);
	} catch (err) {
		// Not near enough to settle (a joint stalled on the way): fall back to one plain correction pass.
		warnings.push(`Droop correction skipped: ${(err as Error).message}.`);
		await jogToward(now.positions, all);
		await new Promise((r) => setTimeout(r, 600));
		now = await readArm();
	}
	// The gripper is not part of the droop pass; one more jog if it is still off.
	const g = SERVO_COUNT - 1;
	if (Math.abs(target[g] - now.positions[g]) > GOTO_DEADBAND + 3) {
		await jogToward(now.positions, [SERVO_COUNT]);
		await new Promise((r) => setTimeout(r, 400));
		now = await readArm();
	}
	const after = now.positions;
	const residual = target.map((t, i) => t - after[i]);
	await audit(user, 'robot_arm.animate.go_to_pose', 'robot_arm_poses', poseId, { name: pose.name, before: start.positions, after, jogs, trim: droop?.trim ?? null });
	return { before: start.positions, after, jogs, residual, droop, warnings };
}

/** One line for the operator: where Go to pose ended and what the droop pass did. */
export function goToMessage(r: GoToResult): string {
	const worst = Math.max(...r.residual.map(Math.abs));
	const t = r.droop?.trim.map((v, i) => (v ? `servo ${i + 1} ${v > 0 ? '+' : ''}${v}` : null)).filter(Boolean) ?? [];
	const droop = r.droop ? (t.length ? ` Droop correction ${t.join(', ')} learned for this pose.` : ' No droop at this pose.') : '';
	return `At the pose (${r.jogs} jog(s), worst servo ${worst} step(s) off).${droop}${r.warnings.length ? ' ' + r.warnings.join(' ') : ''}`;
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
	const rows = (await RobotArmPose.find({ 'trim.5': { $exists: true }, archivedAt: null }).select('_id positions trim').lean()) as any[];
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

export interface SettleResult {
	poseName: string;
	droop: DroopResult | null;
	/** Why nothing was done (the arm is left as the replay left it). */
	skipped: string | null;
}

/**
 * Called by the page when a Play finished on its own (not stopped): the arm
 * is holding the last keyframe, so settle it onto its target and learn that
 * pose's droop. Runs once per play; skips (and says why) when the arm is not
 * where the play should have left it.
 */
export async function settleAfterPlay(user: User, runId: string): Promise<SettleResult> {
	await connectDB();
	const q = { 'lastPlay.runId': runId, 'lastPlay.settledAt': null };
	let model: typeof RobotArmMoveSet = RobotArmMoveSet;
	let doc = (await RobotArmMoveSet.findOne(q).lean()) as any;
	if (!doc) {
		model = RobotArmSequence;
		doc = (await RobotArmSequence.findOne(q).lean()) as any;
	}
	const end = doc?.lastPlay?.end;
	if (!doc || !end?.poseId || !Array.isArray(end.target)) return { poseName: '', droop: null, skipped: 'nothing to settle for this play' };
	// Claim it first so a double call (two tabs, a retry) settles once.
	const claim = await model.updateOne({ _id: doc._id, 'lastPlay.runId': runId, 'lastPlay.settledAt': null }, { $set: { 'lastPlay.settledAt': new Date() } });
	if (!claim.modifiedCount) return { poseName: '', droop: null, skipped: 'already settled' };
	const pose = (await RobotArmPose.findById(end.poseId).lean()) as any;
	if (!pose) return { poseName: '', droop: null, skipped: 'the last pose no longer exists' };
	try {
		await requireIdle();
		const now = await readArm();
		const droop = await settleAtPose(user, pose, end.target.map(Number), now, 'play_end');
		return { poseName: pose.name, droop, skipped: null };
	} catch (err) {
		const skipped = (err as Error).message;
		await audit(user, 'robot_arm.animate.pose_droop_skip', 'robot_arm_poses', String(pose._id), { name: pose.name, reason: 'play_end', runId, skipped });
		return { poseName: pose.name, droop: null, skipped };
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
			const out: Keyframe = { poseId: String(k.poseId), holdS: Number(k.holdS ?? 0), durationS: Number(k.durationS ?? 1), easing: isEasing(k.easing) ? k.easing : 'ease' };
			const offsets = cleanOffsets(k.offsets, MAX_OFFSET_STEPS);
			if (offsets) out.offsets = offsets;
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
	const poseIds = [...new Set(keyframes.map((k) => k.poseId))];
	const found = await RobotArmPose.find({ _id: { $in: poseIds } }).select('_id').lean();
	if (found.length !== poseIds.length) throw new AnimateError('A keyframe refers to a pose that no longer exists — reload the page.');
	await RobotArmMoveSet.updateOne({ _id: id }, { $set: { name, notes: cleanNotes(input.notes), keyframes, updatedBy: opRef(user) } });
	await audit(user, 'robot_arm.animate.move_set_update', 'robot_arm_move_sets', id, { name, keyframes: keyframes.length, before: { name: before.name, keyframes: before.keyframes?.length ?? 0 } });
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
	return keyframes.map((k, i) => {
		const p = poses.get(k.poseId);
		if (!p) throw new AnimateError(`Keyframe ${i + 1} refers to a pose that no longer exists.`);
		let trim = p.trim;
		if (!trim) {
			if (!estimates.has(p._id)) estimates.set(p._id, estimateTrim(p.positions, samples));
			trim = estimates.get(p._id) ?? null;
		}
		const target = keyframePositions(p.positions, k.offsets);
		const positions = keyframePositions(p.positions, k.offsets, trim);
		return { ...k, name: p.name, positions, ...(trim ? { target } : {}) };
	});
}

async function posesById(ids: string[]): Promise<Map<string, PoseSummary>> {
	const rows = await RobotArmPose.find({ _id: { $in: [...new Set(ids)] } }).lean();
	return new Map((rows as any[]).map((d) => [String(d._id), poseSummary(d)]));
}

export async function resolveMoveSet(id: string): Promise<{ summary: MoveSetSummary; keyframes: ResolvedKeyframe[] }> {
	const summary = await getMoveSet(id);
	if (!summary) throw new AnimateError('Move set not found.', 404);
	const [poses, samples] = await Promise.all([posesById(summary.keyframes.map((k) => k.poseId)), trimSamples()]);
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
	const [poses, samples] = await Promise.all([posesById(sets.flatMap((d) => (d.keyframes ?? []).map((k: any) => String(k.poseId)))), trimSamples()]);
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

async function writeAndPlay(user: User, o: { title: string; keyframes: ResolvedKeyframe[]; rateHz: number; kind: 'move_set' | 'sequence'; id: string }): Promise<PlayResult> {
	if (!o.keyframes.length) throw new AnimateError('Nothing to play — add poses first.');
	await requireIdle();
	const now = await readArm();
	if (now.torqueOn === false) throw new AnimateError('Torque is off — press Hold (torque on) first.', 409);
	const path = render(o.keyframes, now.positions, o.rateHz);
	const stats = pathStats(path);
	const warnings: string[] = [];
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
	let runId: string;
	try {
		// The path starts where the arm is, so preflight (±50 steps of frame 0) passes by construction.
		const started = await robotArm.startReplay({ source: PREVIEW_RECORDING, loops: 1, triggered_by: opRef(user), enforce_preflight: true, preflight_tolerance_steps: 50 });
		runId = started.run_id;
	} catch (err) {
		const msg = (err as Error).message ?? String(err);
		throw new AnimateError(msg.includes('409') ? `The Pi refused to start: ${msg}` : `Replay did not start: ${msg}`, 502);
	}
	const model = o.kind === 'move_set' ? RobotArmMoveSet : RobotArmSequence;
	// Where the play leaves the arm, so the page can settle it there afterwards (settleAfterPlay).
	const last = o.keyframes[o.keyframes.length - 1];
	const end = { poseId: last.poseId, target: last.target ?? last.positions };
	await model.updateOne({ _id: o.id }, { $set: { lastPlay: { at: new Date(), by: opRef(user), runId, durationS: path.durationS, end, settledAt: null } } });
	await audit(user, `robot_arm.animate.play_${o.kind}`, o.kind === 'move_set' ? 'robot_arm_move_sets' : 'robot_arm_sequences', o.id, {
		runId,
		durationS: path.durationS,
		leadInS,
		frames: out.frames,
		from: now.positions,
		maxStepsPerS: stats.maxStepsPerS
	});
	return { runId, durationS: path.durationS, leadInS, frames: out.frames, warnings };
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
