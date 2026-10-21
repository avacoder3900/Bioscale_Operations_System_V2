/**
 * Recording clean-up (Clean-up tab) — server side.
 *
 * The flow, all operator-driven:
 *   1. Split: copy a Pi recording into a draft and group its moves into steps
 *      (recording-steps.ts). This is the only automatic part.
 *   2. Edit: the operator deletes, adds, retargets and retimes moves in the
 *      browser and saves the draft here. Optionally reads the follower's
 *      position into a target, or sends the follower to a step's pose to
 *      check it on the real arm.
 *   3. Save to Pi: the draft becomes a NEW recording on the Pi (via the
 *      recording-restore route), replayable from the Control tab. The source
 *      recording is never modified.
 *   3b. Send to Animate: the draft becomes poses + a move set in the Animate
 *      tab (robot_arm_poses / robot_arm_move_sets), where the Animate engine
 *      eases between the poses and the operator can keep adjusting. The
 *      draft is not changed either.
 */
import { connectDB, AuditLog, generateId } from '$lib/server/db';
import { RobotArmMoveSet, RobotArmPose, RobotArmRecordingCleanup } from '$lib/server/db/models';
import { robotArm, type RecordingSidecar, type ServoState } from '$lib/server/robot-arm-client';
import { parseRecording, recordingToSteps, DEFAULT_PAUSE_S } from '$lib/robot-arm/recording-steps';
import {
	SERVO_IDS,
	cleanRecordingName,
	composeRecording,
	draftFromSteps,
	draftToAnimation,
	joints,
	validateDraft,
	type AnimationDraft,
	type CleanDraft
} from '$lib/robot-arm/recording-cleanup';
import { DEFAULT_RATE_HZ } from '$lib/robot-arm/animation';

interface User {
	_id: string;
	username: string;
}

/** Positions the operator sees in the timeline; longer recordings are thinned for display only. */
const MAX_TRACE_POINTS = 6000;
/** The Pi caps one jog at 300 steps (manual_control.MAX_JOG_STEPS). */
const JOG_CHUNK = 300;
/** Move-to-pose refuses bigger per-servo moves; use Jog or replay for those. */
export const MAX_MOVE_STEPS = 1500;
/** Each jog is one round trip to the Pi; this keeps a move inside Vercel's 30 s. */
const MAX_JOGS = 20;
/** A servo within this many steps of its target is left alone. */
const MOVE_DEADBAND = 2;

export class CleanupError extends Error {
	constructor(
		message: string,
		readonly status = 400
	) {
		super(message);
	}
}

async function audit(user: User, action: string, recordId: string, details: Record<string, unknown>) {
	await auditRow(user, 'robot_arm_recording_cleanups', action, recordId, details);
}

async function auditRow(user: User, tableName: string, action: string, recordId: string, details: Record<string, unknown>) {
	await AuditLog.create({
		_id: generateId(),
		tableName,
		recordId,
		action,
		newData: { ...details, userId: user._id },
		changedBy: user.username
	});
}

function opRef(user: User) {
	return { _id: user._id, username: user.username };
}

function cleanSplit(thresholdSteps: unknown, pauseS: unknown) {
	const th = Number(thresholdSteps);
	const ps = Number(pauseS);
	if (!Number.isFinite(th) || th < 0 || th > 500) throw new CleanupError('Threshold must be 0–500 steps.');
	if (!Number.isFinite(ps) || ps < 0.05 || ps > 5) throw new CleanupError('Pause must be 0.05–5 s.');
	return { thresholdSteps: Math.round(th), pauseS: ps };
}

function framesFromRaw(rawT: number[], rawGoal: number[][]) {
	return rawT.map((t, i) => ({
		t,
		positions: Object.fromEntries(SERVO_IDS.map((sid, j) => [String(sid), rawGoal[i][j]]))
	}));
}

/** Split a Pi recording into a new draft. Returns the draft id. */
export async function createCleanup(
	user: User,
	o: { sourceName: string; thresholdSteps: unknown; pauseS?: unknown }
): Promise<string> {
	const split = cleanSplit(o.thresholdSteps, o.pauseS ?? DEFAULT_PAUSE_S);
	if (!o.sourceName) throw new CleanupError('Pick a recording.');

	let exported;
	try {
		exported = await robotArm.exportRecording(o.sourceName);
	} catch (err) {
		throw new CleanupError(`Could not read "${o.sourceName}" from the Pi: ${(err as Error).message}`, 502);
	}
	let parsed;
	try {
		parsed = parseRecording(exported.jsonl);
	} catch (err) {
		throw new CleanupError(`"${o.sourceName}" is not a readable recording: ${(err as Error).message}`);
	}

	// Every frame needs all six servos; carry the last known value over a gap.
	const rawT: number[] = [];
	const rawGoal: number[][] = [];
	let last: number[] | null = null;
	for (const f of parsed.frames) {
		const row = SERVO_IDS.map((sid, j) => {
			const v = f.positions[String(sid)];
			return typeof v === 'number' ? v : (last?.[j] ?? NaN);
		});
		if (row.some((v) => !Number.isFinite(v))) continue;
		rawT.push(f.t);
		rawGoal.push(row);
		last = row;
	}
	if (rawT.length < 2) throw new CleanupError(`"${o.sourceName}" has no frames with all six servos.`);

	const result = recordingToSteps(framesFromRaw(rawT, rawGoal), split);
	const draft = draftFromSteps(result);

	const pi = await robotArm.listRecordings().catch(() => null);
	const meta = pi?.recordings.find((r) => r.name === o.sourceName) ?? null;

	await connectDB();
	const id = generateId();
	await RobotArmRecordingCleanup.create({
		_id: id,
		title: o.sourceName.replace(/\.jsonl$/i, ''),
		sourceName: o.sourceName,
		sourceModified: meta?.modified ?? null,
		sourceSizeBytes: meta?.size_bytes ?? null,
		sourceHeader: parsed.header?.raw ?? null,
		rateHz: parsed.header?.rateHz ?? 30,
		jointNames: joints(parsed.header),
		rawT,
		rawGoal,
		...split,
		start: draft.start,
		steps: draft.steps,
		createdBy: opRef(user),
		updatedBy: opRef(user)
	});
	await audit(user, 'robot_arm.cleanup.create', id, {
		sourceName: o.sourceName,
		...split,
		steps: draft.steps.length,
		frames: rawT.length
	});
	return id;
}

export interface CleanupListRow {
	_id: string;
	title: string;
	sourceName: string;
	stepCount: number;
	savedAs: { name: string; at: string }[];
	updatedAt: string;
	updatedBy: User | null;
}

export async function listCleanups(): Promise<CleanupListRow[]> {
	await connectDB();
	const rows = (await RobotArmRecordingCleanup.aggregate([
		{ $match: { status: 'draft' } },
		{ $sort: { updatedAt: -1 } },
		{ $limit: 100 },
		{
			$project: {
				title: 1,
				sourceName: 1,
				savedAs: 1,
				updatedAt: 1,
				updatedBy: 1,
				stepCount: { $size: '$steps' }
			}
		}
	])) as CleanupListRow[];
	return JSON.parse(JSON.stringify(rows));
}

export interface CleanupDoc extends CleanDraft {
	_id: string;
	title: string;
	sourceName: string;
	sourceModified: string | null;
	rateHz: number;
	jointNames: string[];
	thresholdSteps: number;
	pauseS: number;
	savedAs: { name: string; at: string; by?: User; frames?: number; durationS?: number }[];
	/** Move sets made from this draft (Send to Animate), newest last. */
	moveSets: { moveSetId: string; name: string; at: string; by?: User; poses?: number; keyframes?: number }[];
	updatedAt: string;
	updatedBy: User | null;
	/** Display trace: times and goals per frame (thinned past MAX_TRACE_POINTS). */
	trace: { t: number[]; goal: number[][]; frames: number; durationS: number };
	followerMin: number[] | null;
	followerMax: number[] | null;
}

export async function getCleanup(id: string): Promise<CleanupDoc | null> {
	await connectDB();
	const doc = (await RobotArmRecordingCleanup.findOne({ _id: id, status: 'draft' }).lean()) as Record<string, any> | null;
	if (!doc) return null;
	const rawT: number[] = doc.rawT ?? [];
	const rawGoal: number[][] = doc.rawGoal ?? [];
	const every = Math.max(1, Math.ceil(rawT.length / MAX_TRACE_POINTS));
	const t: number[] = [];
	const goal: number[][] = [];
	for (let i = 0; i < rawT.length; i += every) {
		t.push(rawT[i]);
		goal.push(rawGoal[i]);
	}
	const header = (doc.sourceHeader ?? {}) as Record<string, unknown>;
	const arr = (v: unknown) => (Array.isArray(v) && v.every((x) => typeof x === 'number') ? (v as number[]) : null);
	return JSON.parse(
		JSON.stringify({
			_id: doc._id,
			title: doc.title,
			sourceName: doc.sourceName,
			sourceModified: doc.sourceModified,
			rateHz: doc.rateHz,
			jointNames: doc.jointNames?.length ? doc.jointNames : joints(null),
			thresholdSteps: doc.thresholdSteps,
			pauseS: doc.pauseS,
			start: doc.start ?? {},
			steps: doc.steps ?? [],
			savedAs: doc.savedAs ?? [],
			moveSets: doc.moveSets ?? [],
			updatedAt: doc.updatedAt,
			updatedBy: doc.updatedBy ?? null,
			trace: {
				t,
				goal,
				frames: rawT.length,
				durationS: rawT.length ? rawT[rawT.length - 1] - rawT[0] : 0
			},
			followerMin: arr(header.follower_min),
			followerMax: arr(header.follower_max)
		})
	);
}

/** Save the operator's edits. `payload` is the editor's JSON ({title, start, steps}). */
export async function saveCleanup(user: User, id: string, payload: string): Promise<CleanDraft> {
	let parsed: { title?: unknown; start?: unknown; steps?: unknown };
	try {
		parsed = JSON.parse(payload);
	} catch {
		throw new CleanupError('The editor sent an unreadable draft. Reload the page.');
	}
	let draft: CleanDraft;
	try {
		draft = validateDraft(parsed);
	} catch (err) {
		throw new CleanupError((err as Error).message);
	}
	const title = typeof parsed.title === 'string' ? parsed.title.trim().slice(0, 120) : undefined;
	await connectDB();
	const res = await RobotArmRecordingCleanup.updateOne(
		{ _id: id, status: 'draft' },
		{ $set: { start: draft.start, steps: draft.steps, ...(title !== undefined ? { title } : {}), updatedBy: opRef(user) } }
	);
	if (!res.matchedCount) throw new CleanupError('This clean-up no longer exists.', 404);
	await audit(user, 'robot_arm.cleanup.save', id, {
		steps: draft.steps.length,
		moves: draft.steps.reduce((n, s) => n + s.moves.length, 0)
	});
	return draft;
}

/** Throw away the edits and split the raw recording again with new settings. */
export async function resplitCleanup(user: User, id: string, o: { thresholdSteps: unknown; pauseS: unknown }) {
	const split = cleanSplit(o.thresholdSteps, o.pauseS);
	await connectDB();
	const doc = (await RobotArmRecordingCleanup.findOne({ _id: id, status: 'draft' }).select('rawT rawGoal').lean()) as {
		rawT: number[];
		rawGoal: number[][];
	} | null;
	if (!doc) throw new CleanupError('This clean-up no longer exists.', 404);
	const draft = draftFromSteps(recordingToSteps(framesFromRaw(doc.rawT, doc.rawGoal), split));
	await RobotArmRecordingCleanup.updateOne(
		{ _id: id },
		{ $set: { ...split, start: draft.start, steps: draft.steps, updatedBy: opRef(user) } }
	);
	await audit(user, 'robot_arm.cleanup.resplit', id, { ...split, steps: draft.steps.length });
	return draft.steps.length;
}

export async function archiveCleanup(user: User, id: string) {
	await connectDB();
	const res = await RobotArmRecordingCleanup.updateOne(
		{ _id: id, status: 'draft' },
		{ $set: { status: 'archived', updatedBy: opRef(user) } }
	);
	if (!res.matchedCount) throw new CleanupError('This clean-up no longer exists.', 404);
	await audit(user, 'robot_arm.cleanup.archive', id, {});
}

async function requireIdle() {
	let active;
	try {
		active = (await robotArm.getActive()).active;
	} catch (err) {
		throw new CleanupError(`Cannot reach the arm: ${(err as Error).message}`, 502);
	}
	if (active) throw new CleanupError(`A ${active.kind} session is using the arm. Stop it first.`, 409);
}

function servoMessage(err: unknown): string {
	const msg = (err as Error).message ?? String(err);
	if (/robot-arm 404/.test(msg)) {
		return 'The Pi has no GET /servos route yet (services/robot-arm/scripts/install_servos_route.py).';
	}
	return msg;
}

/** Follower positions, servo id → steps. Read-only. */
export async function readArm(): Promise<{ positions: Record<string, number>; servos: ServoState[] }> {
	await requireIdle();
	return readServos();
}

async function readServos(): Promise<{ positions: Record<string, number>; servos: ServoState[] }> {
	let servos: ServoState[];
	try {
		servos = await robotArm.listServos();
	} catch (err) {
		throw new CleanupError(`Could not read the follower: ${servoMessage(err)}`, 502);
	}
	if (!Array.isArray(servos) || !servos.length) throw new CleanupError('The follower reported no servos.', 502);
	const positions: Record<string, number> = {};
	for (const s of servos) if (Number.isFinite(s.position)) positions[String(s.id)] = s.position;
	return { positions, servos };
}

export interface MoveResult {
	before: Record<string, number>;
	after: Record<string, number>;
	jogs: number;
	/** Target minus where the servo ended up, servos that were moved. */
	residual: Record<string, number>;
}

/**
 * Send the follower to a pose with per-joint jogs (the Pi's only follower move
 * outside a session). Servos in id order, gripper last, each in ≤300-step
 * jogs, then one correction pass for anything still off.
 */
export async function moveArm(user: User, id: string, label: string, targets: Record<string, number>): Promise<MoveResult> {
	const want: [number, number][] = [];
	for (const [k, v] of Object.entries(targets)) {
		const sid = Number(k);
		if (!SERVO_IDS.includes(sid) || !Number.isInteger(v) || v < 0 || v > 4095) {
			throw new CleanupError(`Bad target for servo ${k}.`);
		}
		want.push([sid, v]);
	}
	if (!want.length) throw new CleanupError('Nothing to move.');
	want.sort((a, b) => a[0] - b[0]);

	const { positions: before } = await readArm();
	for (const [sid, target] of want) {
		const now = before[String(sid)];
		if (now === undefined) throw new CleanupError(`Servo ${sid} did not answer.`, 502);
		if (Math.abs(target - now) > MAX_MOVE_STEPS) {
			throw new CleanupError(
				`Servo ${sid} would move ${target - now} steps (more than ${MAX_MOVE_STEPS}). Move it closer on the Jog tab first, or replay instead.`
			);
		}
	}
	const planned = want.reduce((n, [sid, t]) => n + Math.ceil(Math.abs(t - before[String(sid)]) / JOG_CHUNK), 0);
	if (planned > MAX_JOGS) {
		throw new CleanupError(`That pose is ${planned} jogs away (max ${MAX_JOGS} per click). Move it closer on the Jog tab first.`);
	}

	let jogs = 0;
	const jogToward = async (positions: Record<string, number>) => {
		for (const [sid, target] of want) {
			let remaining = target - positions[String(sid)];
			while (Math.abs(remaining) > MOVE_DEADBAND) {
				const chunk = Math.max(-JOG_CHUNK, Math.min(JOG_CHUNK, remaining));
				try {
					await robotArm.jogJoint(sid, chunk);
				} catch (err) {
					throw new CleanupError(`Servo ${sid} jog failed after ${jogs} jogs: ${(err as Error).message}`, 502);
				}
				jogs += 1;
				remaining -= chunk;
			}
		}
	};

	await jogToward(before);
	// Jogs add to the *present* position, which lags a just-written goal, so
	// chunked moves can fall short. One correction pass from a fresh read.
	await new Promise((r) => setTimeout(r, 600));
	let { positions: after } = await readServos();
	if (want.some(([sid, t]) => Math.abs(t - after[String(sid)]) > MOVE_DEADBAND + 3)) {
		await jogToward(after);
		await new Promise((r) => setTimeout(r, 600));
		after = (await readServos()).positions;
	}

	const residual: Record<string, number> = {};
	for (const [sid, t] of want) residual[String(sid)] = t - after[String(sid)];
	await audit(user, 'robot_arm.cleanup.move_arm', id, { label, targets, before, after, jogs });
	return { before, after, jogs, residual };
}

/** Write the saved draft to the Pi as a new recording. */
export async function saveToPi(user: User, id: string, rawName: string) {
	const name = cleanRecordingName(rawName);
	if (!name) throw new CleanupError('Name: letters, numbers, spaces, - _ . only (max 100).');
	await connectDB();
	const doc = (await RobotArmRecordingCleanup.findOne({ _id: id, status: 'draft' }).lean()) as Record<string, any> | null;
	if (!doc) throw new CleanupError('This clean-up no longer exists.', 404);
	const draft = validateDraft({ start: doc.start, steps: doc.steps });
	if (!draft.steps.length) throw new CleanupError('There are no steps to save.');
	const out = composeRecording(draft, {
		sourceHeader: doc.sourceHeader ?? null,
		sourceName: doc.sourceName,
		rateHz: doc.rateHz
	});
	const now = new Date();
	// Extra keys ride along in the Pi's sidecar so a replayed file says where it came from.
	const meta: RecordingSidecar & Record<string, unknown> = {
		schema_version: 1,
		frame_count: out.frames,
		operator: user.username,
		started_at_iso: now.toISOString(),
		rate_hz: doc.rateHz,
		cleaned_from: doc.sourceName,
		cleanup_id: id
	};
	try {
		await robotArm.restoreRecording({
			name,
			jsonl: out.jsonl,
			meta
		});
	} catch (err) {
		const msg = (err as Error).message ?? '';
		if (msg.includes('robot-arm 409')) throw new CleanupError(`"${name}" already exists on the Pi. Pick another name.`, 409);
		throw new CleanupError(`The Pi did not take the recording: ${msg}`, 502);
	}
	await RobotArmRecordingCleanup.updateOne(
		{ _id: id },
		{ $push: { savedAs: { name: `${name}.jsonl`, at: now, by: opRef(user), frames: out.frames, durationS: out.durationS } } }
	);
	await audit(user, 'robot_arm.cleanup.save_to_pi', id, {
		name: `${name}.jsonl`,
		sourceName: doc.sourceName,
		steps: draft.steps.length,
		frames: out.frames,
		durationS: out.durationS
	});
	return { name: `${name}.jsonl`, frames: out.frames, durationS: out.durationS };
}

export interface SendToAnimateResult {
	moveSetId: string;
	name: string;
	poses: number;
	keyframes: number;
	folded: number[];
	lengthened: number[];
}

/** Move-set names are free text in the Animate tab; pose names must be unique among live poses. */
const ANIMATE_NAME_MAX = 80;

/**
 * Turn the saved draft into a move set in the Animate tab: one saved pose for
 * the start and for the end of every step that moves something, and a move
 * set whose keyframes copy each step's time (lengthened to the arm's speed
 * limit where needed) and pause. The Animate engine renders the easing
 * between the poses; the operator adjusts the rest there. The draft is left
 * as it is.
 */
export async function sendToAnimate(user: User, id: string, o: { name: unknown; easing: unknown }): Promise<SendToAnimateResult> {
	await connectDB();
	const doc = (await RobotArmRecordingCleanup.findOne({ _id: id, status: 'draft' }).lean()) as Record<string, any> | null;
	if (!doc) throw new CleanupError('This clean-up no longer exists.', 404);
	const draft = validateDraft({ start: doc.start, steps: doc.steps });
	if (!draft.steps.length) throw new CleanupError('There are no steps to animate.');
	let anim: AnimationDraft;
	try {
		anim = draftToAnimation(draft, { easing: o.easing });
	} catch (err) {
		throw new CleanupError((err as Error).message);
	}
	const fallback = String(doc.title || doc.sourceName || '').replace(/\.jsonl$/i, '');
	const name = (String(o.name ?? '').trim() || fallback).slice(0, ANIMATE_NAME_MAX);
	if (!name) throw new CleanupError('Give the move set a name.');

	// The Animate tab refuses a second live pose with the same name (case-insensitive); suffix clashes.
	const live = (await RobotArmPose.find({ archivedAt: null }).select('name').lean()) as { name: string }[];
	const taken = new Set(live.map((p) => String(p.name).toLowerCase()));
	const unique = (base: string) => {
		let n = base.slice(0, ANIMATE_NAME_MAX);
		for (let i = 2; taken.has(n.toLowerCase()); i++) {
			const suffix = ` (${i})`;
			n = base.slice(0, ANIMATE_NAME_MAX - suffix.length) + suffix;
		}
		taken.add(n.toLowerCase());
		return n;
	};

	const now = new Date();
	const source = String(doc.sourceName);
	const poseDocs = anim.poses.map((p) => ({
		_id: generateId(),
		name: unique(`${name} · ${p.label}`),
		positions: p.positions,
		notes: p.step === 0 ? `Start pose of clean-up "${source}".` : `End of step ${p.step} of clean-up "${source}".`,
		createdBy: opRef(user),
		archivedAt: null
	}));
	await RobotArmPose.insertMany(poseDocs);
	const keyframes = anim.keyframes.map((k) => ({
		poseId: poseDocs[k.pose]._id,
		holdS: k.holdS,
		durationS: k.durationS,
		easing: k.easing
	}));
	const moveSetId = generateId();
	const notes = [
		`From clean-up "${source}" (${draft.steps.length} steps). Each step's time and pause became the move into its pose and the hold; adjust them and the easing here.`,
		anim.lengthened.length ? `Step${anim.lengthened.length > 1 ? 's' : ''} ${anim.lengthened.join(', ')} lengthened to the arm's speed limit.` : '',
		anim.folded.length ? `Step${anim.folded.length > 1 ? 's' : ''} ${anim.folded.join(', ')} moved nothing and became hold time.` : ''
	]
		.filter(Boolean)
		.join(' ')
		.slice(0, 500);
	await RobotArmMoveSet.create({
		_id: moveSetId,
		name,
		notes,
		keyframes,
		rateHz: Number(doc.rateHz) || DEFAULT_RATE_HZ,
		createdBy: opRef(user),
		updatedBy: opRef(user)
	});
	await RobotArmRecordingCleanup.updateOne(
		{ _id: id },
		{
			$push: { moveSets: { moveSetId, name, at: now, by: opRef(user), poses: poseDocs.length, keyframes: keyframes.length } },
			$set: { updatedBy: opRef(user) }
		}
	);
	const details = { cleanupId: id, sourceName: source, moveSetId, name, poses: poseDocs.length, keyframes: keyframes.length, folded: anim.folded, lengthened: anim.lengthened };
	await auditRow(user, 'robot_arm_poses', 'robot_arm.animate.pose_save_from_cleanup', moveSetId, { ...details, poseIds: poseDocs.map((p) => p._id) });
	await auditRow(user, 'robot_arm_move_sets', 'robot_arm.animate.move_set_create', moveSetId, details);
	await audit(user, 'robot_arm.cleanup.send_to_animate', id, details);
	return { moveSetId, name, poses: poseDocs.length, keyframes: keyframes.length, folded: anim.folded, lengthened: anim.lengthened };
}
