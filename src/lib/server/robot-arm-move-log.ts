/**
 * Robot arm Movement Log — the writes and reads (2026-11-06).
 *
 * robotArmFetch calls recordArmMove() after every POST to the Pi; the ones
 * describeArmMove() calls a movement become a robot_arm_moves row, whether
 * the Pi took them or not. Who sent it comes from withArmActor(), which
 * hooks.server.ts wraps every request in, so no route has to pass the user
 * down. Never throws: a move that happened must not fail because its log
 * row did not.
 *
 * A play's row keeps its frames (2026-11-06): a BIMS-built play hands its
 * JSONL over with withPlayRecording(); a play of a Pi recording by name has
 * it read back from the Pi once the play has started (robot-arm-client).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { connectDB } from './db/connection';
import { RobotArmMove } from './db/models';
import {
	describeArmMove,
	FIRE_KINDS,
	frameStats,
	moveLine,
	playFramesFromJsonl,
	readingLine,
	type ArmMoveEntry,
	type ArmMoveKind,
	type FrameServoStats,
	type PlayFrames,
	type ServoReading
} from '$lib/robot-arm/move-log';
import { ot2ActionOf } from '$lib/robot-arm/ot2-move-log';
import type { ArrivalReport, PoseSaveReport, ServoRegisterState, ServoTrace } from '$lib/robot-arm/arrival';
import { generateId } from './db/utils';
import { groupKindQuery, moveGroup } from '$lib/robot-arm/move-types';

interface ArmActor {
	user: { _id: string; username: string } | null;
	from: string | null;
	/** The recording a Play inside withPlayRecording() is starting. */
	play?: { title: string; jsonl: string } | null;
}

const actorStore = new AsyncLocalStorage<ArmActor>();

/** Run a request with its user and path on hand for the Movement Log. */
export function withArmActor<T>(actor: ArmActor, fn: () => T): T {
	return actorStore.run(actor, fn);
}

/** Start a Play with the JSONL it plays on hand, so its Movement Log row keeps every frame. */
export function withPlayRecording<T>(play: { title: string; jsonl: string }, fn: () => T): T {
	const cur = actorStore.getStore();
	return actorStore.run({ user: cur?.user ?? null, from: cur?.from ?? null, play }, fn);
}

/** The user and page of the request being handled, when there is one. */
export const currentArmActor = (): ArmActor | null => actorStore.getStore() ?? null;

export interface ArmMoveRow {
	_id: string;
	/** 'ot2' for an Opentrons command; missing or 'arm' for the arm. */
	device?: 'arm' | 'ot2' | 'link';
	at: string;
	endAt?: string | null;
	/** An arm kind, or an OT-2 commandType for an Opentrons row. */
	kind: ArmMoveKind | string;
	servo: number | null;
	goal: number | null;
	delta: number | null;
	goals: Record<string, number> | null;
	what: string | null;
	line: string;
	ok: boolean;
	error: string | null;
	durationMs: number | null;
	from: string | null;
	movedBy: { _id?: string; username?: string } | null;
	robot?: { _id?: string; name?: string } | null;
	runId?: string | null;
	seq?: number | null;
	params?: Record<string, unknown> | null;
	cart?: number | null;
	readings?: ServoReading[] | null;
	moveId?: string | null;
	/** Play rows: how many frames, and per servo its travel and turns (the frames themselves load on demand). */
	frameCount?: number | null;
	frameStats?: Record<string, FrameServoStats> | null;
	/** Arrival rows (2026-11-10): target vs where the play left each servo. */
	arrival?: ArrivalReport | null;
	/** Arrival rows: the servos' own registers, when the Pi has GET /servos/state. */
	servoState?: ServoRegisterState[] | null;
	/** Pose Saved rows: what changed and where the arm was. */
	poseSave?: PoseSaveReport | null;
	poseId?: string | null;
	settledMs?: number | null;
}

export async function recordArmMove(
	method: string,
	path: string,
	body: unknown,
	response: unknown,
	error: unknown,
	startedAt: number,
	id: string = generateId(),
	/** A play's frames when they did not come through withPlayRecording (a Pi recording read back). */
	given: PlayFrames | null = null
): Promise<ArmMoveEntry | null> {
	const e = describeArmMove(method, path, body, response);
	// Unit tests drive mocked Pi calls; they must never write to the shared DB.
	if (!e || process.env.VITEST) return e;
	const actor = actorStore.getStore();
	const play = e.kind === 'play' ? (actor?.play ?? null) : null;
	if (play) e.what = play.title;
	const frames = e.kind === 'play' ? (play ? playFramesFromJsonl(play.jsonl) : given) : null;
	try {
		await connectDB();
		await RobotArmMove.create({
			_id: id,
			at: new Date(startedAt),
			...e,
			line: frames ? `${moveLine(e)}  ${frames.t.length} Frames` : moveLine(e),
			...(frames ? { frames, frameCount: frames.t.length, frameStats: frameStats(frames) } : {}),
			// The Pi's run id (2026-11-10), so the play's Arrival row can find it.
			...(e.kind === 'play' && typeof (response as { run_id?: unknown } | null)?.run_id === 'string' ? { runId: (response as { run_id: string }).run_id } : {}),
			ok: !error,
			error: error ? (error instanceof Error ? error.message : String(error)).slice(0, 300) : null,
			durationMs: Date.now() - startedAt,
			from: actor?.from ?? null,
			movedBy: actor?.user ? { _id: actor.user._id, username: actor.user.username } : null
		});
	} catch (err) {
		console.warn('[arm-move-log] write failed:', err instanceof Error ? err.message : err);
	}
	return e;
}

/** One servo reading row around move `moveId`: the read's result, or why it failed. */
export async function recordArmReading(o: {
	phase: 'before' | 'after';
	moveId: string;
	at: number;
	durationMs: number;
	readings: ServoReading[] | null;
	error: string | null;
	servo: number | null;
	goal?: number | null;
	settledMs?: number | null;
	note?: string | null;
}): Promise<void> {
	if (process.env.VITEST) return;
	const actor = actorStore.getStore();
	const title = o.phase === 'before' ? 'Before' : 'After';
	try {
		await connectDB();
		await RobotArmMove.create({
			device: 'arm',
			at: new Date(o.at),
			kind: o.phase === 'before' ? 'reading_before' : 'reading_after',
			servo: o.servo,
			line: o.readings
				? readingLine(o.phase, o.readings, { servo: o.servo, goal: o.goal, settledMs: o.settledMs, note: o.note })
				: `${title}${o.servo != null ? `  Servo ${o.servo}` : ''}  Not Read`,
			ok: !!o.readings,
			error: o.error ? o.error.slice(0, 300) : null,
			durationMs: o.durationMs,
			from: actor?.from ?? null,
			movedBy: actor?.user ? { _id: actor.user._id, username: actor.user.username } : null,
			readings: o.readings ? (o.servo != null ? o.readings.filter((r) => r.id === o.servo) : o.readings) : null,
			moveId: o.moveId
		});
	} catch (err) {
		console.warn('[arm-move-log] reading write failed:', err instanceof Error ? err.message : err);
	}
}

/**
 * An OT-2 home or rail-lights request sent outside a run (2026-11-06), from
 * the server (proxy.ts robotPost: BIMS routes and the relay) or reported by
 * the browser's direct line (direct-calls). Anything else is ignored.
 */
export async function recordOt2Action(o: {
	robot: { _id?: unknown; name?: unknown };
	method: string;
	path: string;
	body: unknown;
	ok: boolean;
	error: string | null;
	at: number;
	durationMs: number;
	from?: string | null;
	user?: { _id?: string; username?: string } | null;
}): Promise<void> {
	const a = ot2ActionOf(o.method, o.path, o.body);
	if (!a || process.env.VITEST) return;
	const actor = actorStore.getStore();
	const user = actor?.user ?? o.user ?? null;
	try {
		await connectDB();
		await RobotArmMove.create({
			device: 'ot2',
			at: new Date(o.at),
			endAt: new Date(o.at + o.durationMs),
			durationMs: o.durationMs,
			kind: a.kind,
			servo: null,
			goal: null,
			delta: null,
			goals: null,
			what: null,
			line: a.line,
			ok: o.ok,
			error: o.error ? o.error.slice(0, 300) : null,
			from: o.from ?? actor?.from ?? null,
			movedBy: user?.username ? { _id: user._id, username: user.username } : null,
			robot: { _id: String(o.robot._id ?? ''), name: String(o.robot.name ?? '') },
			...(a.runId ? { runId: a.runId, detail: { actionType: a.actionType } } : {})
		});
	} catch (err) {
		console.warn('[ot2-move-log] action write failed:', err instanceof Error ? err.message : err);
	}
}

export interface ArmMoveFilter {
	sinceMinutes?: number | null;
	servo?: number | null;
	device?: 'arm' | 'ot2' | 'link' | null;
	/** A Movement Log type group id ("ot2:liquid"); picks its device too. */
	group?: string | null;
	/** One exact kind ("aspirate"); wins over the group. */
	kind?: string | null;
}

function moveQuery(o: ArmMoveFilter): Record<string, unknown> {
	const q: Record<string, unknown> = {};
	const g = moveGroup(o.group);
	const device = o.servo ? 'arm' : (g?.device ?? o.device ?? null);
	// Rows from before 2026-11-06 carry no device: they are the arm's. A servo means the arm.
	if (device === 'ot2' || device === 'link') q.device = device;
	else if (device === 'arm') q.device = { $nin: ['ot2', 'link'] };
	if (o.kind) q.kind = o.kind;
	else if (g) q.kind = groupKindQuery(g);
	if (o.sinceMinutes && o.sinceMinutes > 0) q.at = { $gte: new Date(Date.now() - o.sinceMinutes * 60_000) };
	// Conveyor Belt and Trapdoor Solenoid rows drive no servo, so a servo filter leaves them out.
	if (o.servo) q.$or = [{ servo: o.servo }, { [`goals.${o.servo}`]: { $exists: true } }, { servo: null, goals: null, kind: { $nin: [...FIRE_KINDS] } }];
	return q;
}

/**
 * Newest first; `sinceMinutes` and `servo` narrow it. A servo also matches
 * whole-arm rows: the ones that set it (hold, Cartesian jog) and the ones
 * that drive every servo (play, leader arm, task, torque, Stop). `device`
 * picks the arm or the OT-2 (Opentrons rows, 2026-11-06); `group` and `kind`
 * a type ($lib/robot-arm/move-types). `limit` null = every row.
 */
export async function listArmMoves(o: ArmMoveFilter & { limit?: number | null } = {}): Promise<ArmMoveRow[]> {
	await connectDB();
	let find = RobotArmMove.find(moveQuery(o)).sort({ at: -1 });
	if (o.limit !== null) find = find.limit(Math.min(Math.max(o.limit ?? 500, 1), 5000));
	const rows = await find
		.select('device at endAt kind servo goal delta goals what line ok error durationMs from movedBy robot runId seq params cart readings moveId frameCount frameStats arrival servoState poseSave poseId settledMs')
		.lean();
	return JSON.parse(JSON.stringify(rows));
}

/** One play's frames, for the log's Show Frames. Null when the row has none. */
export async function getArmMoveFrames(id: string): Promise<PlayFrames | null> {
	await connectDB();
	const row = (await RobotArmMove.findById(id).select('frames').lean()) as { frames?: PlayFrames } | null;
	return row?.frames ?? null;
}

/** One Arrival row's fast trace, for the log's Show Trace (2026-11-11). Null when the row has none. */
export async function getArmMoveTrace(id: string): Promise<ServoTrace | null> {
	await connectDB();
	const row = (await RobotArmMove.findById(id).select('trace').lean()) as { trace?: ServoTrace } | null;
	return row?.trace ?? null;
}

/** How many rows match, for "Showing 100 of 4210". */
export async function countArmMoves(o: ArmMoveFilter = {}): Promise<number> {
	await connectDB();
	return RobotArmMove.countDocuments(moveQuery(o));
}

/** Every kind in the log per device, for the type filter. */
export async function listMoveKinds(): Promise<{ device: 'arm' | 'ot2' | 'link'; kind: string; count: number }[]> {
	await connectDB();
	const rows: { _id: { device: string; kind: string }; count: number }[] = await RobotArmMove.aggregate([
		{ $group: { _id: { device: { $cond: [{ $in: ['$device', ['ot2', 'link']] }, '$device', 'arm'] }, kind: '$kind' }, count: { $sum: 1 } } }
	]);
	return rows.map((r) => ({ device: r._id.device as 'arm' | 'ot2' | 'link', kind: r._id.kind, count: r.count }));
}
