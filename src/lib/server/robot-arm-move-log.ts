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
import { describeArmMove, moveLine, type ArmMoveKind } from '$lib/robot-arm/move-log';

interface ArmActor {
	user: { _id: string; username: string } | null;
	from: string | null;
}

const actorStore = new AsyncLocalStorage<ArmActor>();

/** Run a request with its user and path on hand for the Movement Log. */
export function withArmActor<T>(actor: ArmActor, fn: () => T): T {
	return actorStore.run(actor, fn);
}

export interface ArmMoveRow {
	_id: string;
	at: string;
	kind: ArmMoveKind;
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
}

export async function recordArmMove(
	method: string,
	path: string,
	body: unknown,
	response: unknown,
	error: unknown,
	startedAt: number
): Promise<void> {
	const e = describeArmMove(method, path, body, response);
	// Unit tests drive mocked Pi calls; they must never write to the shared DB.
	if (!e || process.env.VITEST) return;
	const actor = actorStore.getStore();
	try {
		await connectDB();
		await RobotArmMove.create({
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
}

/**
 * Newest first; `sinceMinutes` and `servo` narrow it. A servo also matches
 * whole-arm rows: the ones that set it (hold, Cartesian jog) and the ones
 * that drive every servo (play, leader arm, task, torque, Stop).
 */
export async function listArmMoves(o: { sinceMinutes?: number | null; servo?: number | null; limit?: number } = {}): Promise<ArmMoveRow[]> {
	await connectDB();
	const q: Record<string, unknown> = {};
	if (o.sinceMinutes && o.sinceMinutes > 0) q.at = { $gte: new Date(Date.now() - o.sinceMinutes * 60_000) };
	if (o.servo) q.$or = [{ servo: o.servo }, { [`goals.${o.servo}`]: { $exists: true } }, { servo: null, goals: null }];
	const rows = await RobotArmMove.find(q)
		.sort({ at: -1 })
		.limit(Math.min(Math.max(o.limit ?? 500, 1), 5000))
		.select('at kind servo goal delta goals what line ok error durationMs from movedBy')
		.lean();
	return JSON.parse(JSON.stringify(rows));
}
