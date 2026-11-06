/**
 * Robot arm Movement Log — the writes and reads (2026-11-06).
 *
 * robotArmFetch calls recordArmMove() after every POST to the Pi; the ones
 * describeArmMove() calls a movement become a robot_arm_moves row, whether
 * the Pi took them or not. Who sent it comes from withArmActor(), which
 * hooks.server.ts wraps every request in, so no route has to pass the user
 * down. Never throws: a move that happened must not fail because its log
 * row did not.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { connectDB } from './db/connection';
import { RobotArmMove } from './db/models';
import { describeArmMove, moveLine, readingLine, type ArmMoveEntry, type ArmMoveKind, type ServoReading } from '$lib/robot-arm/move-log';
import { ot2ActionOf } from '$lib/robot-arm/ot2-move-log';
import { generateId } from './db/utils';
import { groupKindQuery, moveGroup } from '$lib/robot-arm/move-types';

interface ArmActor {
	user: { _id: string; username: string } | null;
	from: string | null;
}

const actorStore = new AsyncLocalStorage<ArmActor>();

/** Run a request with its user and path on hand for the Movement Log. */
export function withArmActor<T>(actor: ArmActor, fn: () => T): T {
	return actorStore.run(actor, fn);
}

/** The user and page of the request being handled, when there is one. */
export const currentArmActor = (): ArmActor | null => actorStore.getStore() ?? null;

export interface ArmMoveRow {
	_id: string;
	/** 'ot2' for an Opentrons command; missing or 'arm' for the arm. */
	device?: 'arm' | 'ot2';
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
}

export async function recordArmMove(
	method: string,
	path: string,
	body: unknown,
	response: unknown,
	error: unknown,
	startedAt: number,
	id: string = generateId()
): Promise<ArmMoveEntry | null> {
	const e = describeArmMove(method, path, body, response);
	// Unit tests drive mocked Pi calls; they must never write to the shared DB.
	if (!e || process.env.VITEST) return e;
	const actor = actorStore.getStore();
	try {
		await connectDB();
		await RobotArmMove.create({
			_id: id,
			at: new Date(startedAt),
			...e,
			line: moveLine(e),
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
			robot: { _id: String(o.robot._id ?? ''), name: String(o.robot.name ?? '') }
		});
	} catch (err) {
		console.warn('[ot2-move-log] action write failed:', err instanceof Error ? err.message : err);
	}
}

export interface ArmMoveFilter {
	sinceMinutes?: number | null;
	servo?: number | null;
	device?: 'arm' | 'ot2' | null;
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
	if (device === 'ot2') q.device = 'ot2';
	else if (device === 'arm') q.device = { $ne: 'ot2' };
	if (o.kind) q.kind = o.kind;
	else if (g) q.kind = groupKindQuery(g);
	if (o.sinceMinutes && o.sinceMinutes > 0) q.at = { $gte: new Date(Date.now() - o.sinceMinutes * 60_000) };
	if (o.servo) q.$or = [{ servo: o.servo }, { [`goals.${o.servo}`]: { $exists: true } }, { servo: null, goals: null }];
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
		.select('device at endAt kind servo goal delta goals what line ok error durationMs from movedBy robot runId seq params cart readings moveId')
		.lean();
	return JSON.parse(JSON.stringify(rows));
}

/** How many rows match, for "Showing 100 of 4210". */
export async function countArmMoves(o: ArmMoveFilter = {}): Promise<number> {
	await connectDB();
	return RobotArmMove.countDocuments(moveQuery(o));
}

/** Every kind in the log per device, for the type filter. */
export async function listMoveKinds(): Promise<{ device: 'arm' | 'ot2'; kind: string; count: number }[]> {
	await connectDB();
	const rows: { _id: { device: string; kind: string }; count: number }[] = await RobotArmMove.aggregate([
		{ $group: { _id: { device: { $cond: [{ $eq: ['$device', 'ot2'] }, 'ot2', 'arm'] }, kind: '$kind' }, count: { $sum: 1 } } }
	]);
	return rows.map((r) => ({ device: r._id.device as 'arm' | 'ot2', kind: r._id.kind, count: r.count }));
}
