/**
 * Robot arm — pose animation (ARM-06 Animate): the I/O half.
 *
 * Pure decisions live in $lib/robot-arm/animation (easing, path rendering,
 * sequence flattening, the Pi's recording format), unit-tested. This module
 * owns the pose / move-set / sequence records, the by-hand capture flow, and
 * playback: render the path from where the arm is now, write it to the Pi as
 * a scratch recording, start a replay.
 *
 * Pi calls:
 *   GET  /servos                 follower positions + torque state
 *   POST /torque                 torque OFF so the operator can pose by hand
 *   POST /servos/hold            goal := present, torque ON (no jump) — hold.py
 *   POST /servos/{id}/jog        go to a pose (≤300 steps per jog)
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
	composeAnimationJsonl,
	flattenSequence,
	isEasing,
	pathStats,
	tooFast,
	DEFAULT_RATE_HZ,
	MAX_TRANSITION_S,
	MIN_TRANSITION_S,
	SERVO_COUNT,
	type Easing,
	type Keyframe,
	type RenderedPath,
	type ResolvedKeyframe,
	type SequenceItem
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

// ── poses ────────────────────────────────────────────────────────────────

export interface PoseSummary {
	_id: string;
	name: string;
	positions: number[];
	notes: string | null;
	archived: boolean;
	createdAt: string | null;
	createdBy: { username?: string } | null;
}

function poseSummary(d: any): PoseSummary {
	return {
		_id: String(d._id),
		name: d.name,
		positions: (d.positions ?? []).map(Number),
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
	if (input.fromArm) set.positions = (await readArm()).positions;
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
}

/**
 * Drive the follower to a pose with per-joint jogs (≤300 steps each, servos
 * in id order so the gripper goes last), then one correction pass. Torque
 * must be on. The arm MOVES.
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
	const jogToward = async (from: number[]) => {
		for (let i = 0; i < SERVO_COUNT; i++) {
			let remaining = target[i] - from[i];
			while (Math.abs(remaining) > GOTO_DEADBAND) {
				const chunk = Math.max(-JOG_CHUNK, Math.min(JOG_CHUNK, remaining));
				try {
					await robotArm.jogJoint(i + 1, chunk);
				} catch (err) {
					throw new AnimateError(`Servo ${i + 1} jog failed after ${jogs} jogs: ${(err as Error).message}`, 502);
				}
				jogs++;
				remaining -= chunk;
			}
		}
	};
	await jogToward(start.positions);
	await new Promise((r) => setTimeout(r, 600));
	let after = (await readArm()).positions;
	if (after.some((p, i) => Math.abs(target[i] - p) > GOTO_DEADBAND + 3)) {
		await jogToward(after);
		await new Promise((r) => setTimeout(r, 600));
		after = (await readArm()).positions;
	}
	const residual = target.map((t, i) => t - after[i]);
	await audit(user, 'robot_arm.animate.go_to_pose', 'robot_arm_poses', poseId, { name: pose.name, before: start.positions, after, jogs });
	return { before: start.positions, after, jogs, residual };
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
		keyframes: (d.keyframes ?? []).map((k: any): Keyframe => ({ poseId: String(k.poseId), holdS: Number(k.holdS ?? 0), durationS: Number(k.durationS ?? 1), easing: isEasing(k.easing) ? k.easing : 'ease' })),
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

/** Keyframes with their poses' positions filled in; archived poses still resolve. */
export function resolveKeyframes(keyframes: Keyframe[], poses: Map<string, PoseSummary>): ResolvedKeyframe[] {
	return keyframes.map((k, i) => {
		const p = poses.get(k.poseId);
		if (!p) throw new AnimateError(`Keyframe ${i + 1} refers to a pose that no longer exists.`);
		return { ...k, name: p.name, positions: p.positions };
	});
}

async function posesById(ids: string[]): Promise<Map<string, PoseSummary>> {
	const rows = await RobotArmPose.find({ _id: { $in: [...new Set(ids)] } }).lean();
	return new Map((rows as any[]).map((d) => [String(d._id), poseSummary(d)]));
}

export async function resolveMoveSet(id: string): Promise<{ summary: MoveSetSummary; keyframes: ResolvedKeyframe[] }> {
	const summary = await getMoveSet(id);
	if (!summary) throw new AnimateError('Move set not found.', 404);
	const poses = await posesById(summary.keyframes.map((k) => k.poseId));
	return { summary, keyframes: resolveKeyframes(summary.keyframes, poses) };
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
	const poses = await posesById(sets.flatMap((d) => (d.keyframes ?? []).map((k: any) => String(k.poseId))));
	const items: SequenceItem[] = summary.items.map((it, i) => {
		const ms = byId.get(it.moveSetId);
		if (!ms) throw new AnimateError(`Item ${i + 1} refers to a move set that no longer exists.`);
		return { name: ms.name, keyframes: resolveKeyframes(ms.keyframes, poses), join: { durationS: it.joinDurationS, easing: it.joinEasing } };
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
	await model.updateOne({ _id: o.id }, { $set: { lastPlay: { at: new Date(), by: opRef(user), runId, durationS: path.durationS } } });
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
