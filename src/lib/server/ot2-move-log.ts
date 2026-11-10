/**
 * Opentrons rows in the Movement Log — the robot reads and the writes
 * (2026-11-06). Lines and timing in $lib/robot-arm/ot2-move-log.
 *
 * syncOt2Robot() reads the robot's recent runs (GET /runs) and, for each run
 * not yet fully logged, its command log from where the last read stopped
 * (Ot2MoveSync.cursor), writing one robot_arm_moves row per command that has
 * ended. Row ids are the run id + the command's index, so a read repeated
 * after a timeout never doubles a row. Bounded by a time budget: whatever is
 * left is read next time. Callers: the Movement Log page on load and the
 * wax-fill loop when its OT-2 run ends.
 *
 * recordArmLoopStep() writes the arm's measured side: one row per loop play
 * (Grab, Withdraw, Fail), from the play request to the arrival check.
 *
 * Neither throws: a missing log row must never fail a run or a page.
 */
import { connectDB } from './db/connection';
import { Ot2MoveSync, RobotArmMove } from './db/models';
import { getRobot, robotGet } from './opentrons/proxy';
import { armLinkStatus, robotSlot } from './ot2-arm-link';
import { runHistoryRows, type SentAction } from '$lib/robot-arm/run-history';
import {
	commandTiming,
	isRunEnded,
	onPiClock,
	keptParams,
	loopStepLine,
	ot2CommandError,
	ot2CommandLine,
	pickLoggable,
	runNames,
	type LoopStep,
	type Ot2RowDraft,
	type Ot2RunNames
} from '$lib/robot-arm/ot2-move-log';
import type { Ot2CommandSummary } from '$lib/robot-arm/run-profile';

const PAGE = 100;
/** Runs older than this are not read back (the robot keeps only its last ~20 anyway). */
const RECENT_DAYS = 7;

class OutOfTime extends Error {}

export interface Ot2SyncResult {
	robot: string | null;
	logged: number;
	/** More is left to read (out of budget, or a run still going). */
	pending: boolean;
	error: string | null;
}

async function readJson(robot: any, path: string, deadline: number): Promise<any> {
	const left = deadline - Date.now();
	if (left <= 0) throw new OutOfTime();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new OutOfTime()), left)));
	try {
		const r = await Promise.race([robotGet(robot, path), late]);
		if (!r.ok) throw new Error(`GET ${path} → HTTP ${r.status}`);
		return await r.json();
	} finally {
		clearTimeout(timer);
	}
}

async function protocolName(robot: any, protocolId: unknown, deadline: number): Promise<string | null> {
	if (typeof protocolId !== 'string' || !protocolId) return null;
	try {
		const p = (await readJson(robot, `/protocols/${protocolId}`, deadline))?.data;
		return String(p?.metadata?.protocolName ?? p?.files?.[0]?.name ?? '') || null;
	} catch (e) {
		if (e instanceof OutOfTime) throw e;
		return null;
	}
}

/** Movement Log rows for ended OT-2 commands; times on the arm Pi's clock when its offset is known. */
export function ot2Docs(robotRef: { _id: string; name: string }, runId: string, from: string, names: Ot2RunNames, rows: Ot2RowDraft[], clockOffsetMs: number | null) {
	return rows.flatMap(({ seq, command: c }) => {
		const raw = commandTiming(c);
		if (!raw) return [];
		const t = onPiClock(raw, clockOffsetMs);
		return [
			{
				_id: `ot2-${runId}-${seq}`,
				device: 'ot2',
				...t,
				kind: c.commandType,
				servo: null,
				goal: null,
				delta: null,
				goals: null,
				what: null,
				line: ot2CommandLine(c, names).slice(0, 500),
				ok: c.status === 'succeeded',
				error: ot2CommandError(c),
				from,
				movedBy: null,
				robot: robotRef,
				runId,
				seq,
				commandId: c.id ?? null,
				intent: c.intent ?? null,
				params: keptParams(c.params),
				clockOffsetMs: clockOffsetMs ?? null
			}
		];
	});
}

/** Insert rows; a repeated row (same run + index) is skipped, the rest go in. Returns how many went in. */
export async function insertOt2Docs(docs: unknown[]): Promise<number> {
	if (!docs.length) return 0;
	try {
		await RobotArmMove.insertMany(docs, { ordered: false });
		return docs.length;
	} catch (e: any) {
		if (e?.code !== 11000 && !e?.writeErrors?.every?.((w: any) => (w.code ?? w.err?.code) === 11000)) throw e;
		return Number(e?.insertedDocs?.length ?? e?.result?.insertedCount ?? 0);
	}
}

/** The robot's clock offset the arm Pi measured over the cable, when the Pi's link is to THIS robot. */
async function piClockOffset(robot: any): Promise<number | null> {
	try {
		const { status } = await armLinkStatus();
		const off = (status as any)?.clock?.offset_ms;
		return status && robotSlot(status.robot?.name) === robotSlot(robot?.name) && Number.isFinite(off) ? Number(off) : null;
	} catch {
		return null;
	}
}

/** When BIMS began logging its run-action sends: robot actions before it have no known source. */
let sentSinceCache: Date | null = null;
async function sentLoggedSince(): Promise<Date | null> {
	if (sentSinceCache) return sentSinceCache;
	const first = (await RobotArmMove.findOne({ kind: 'run_action_sent' }).sort({ at: 1 }).select('at').lean()) as any;
	if (first?.at) sentSinceCache = new Date(first.at);
	return sentSinceCache;
}

/** The run's own play / pause / stop and run-level errors (2026-11-10). Never throws. */
async function logRunHistory(robotRef: { _id: string; name: string }, runId: string, from: string, run: any, clockOffsetMs: number | null): Promise<{ logged: number; deferred: number }> {
	if (!Array.isArray(run?.actions) && !Array.isArray(run?.errors)) return { logged: 0, deferred: 0 };
	try {
		const sent = ((await RobotArmMove.find({ device: 'ot2', kind: 'run_action_sent', runId }).select('at ok detail movedBy from').lean()) as any[]).map(
			(r): SentAction => ({ at: new Date(r.at), actionType: String(r.detail?.actionType ?? 'unknown'), ok: r.ok !== false, username: r.movedBy?.username ?? null, from: r.from ?? null })
		);
		const h = runHistoryRows({ robot: robotRef, runId, from, run, sent, sentSince: await sentLoggedSince(), clockOffsetMs, now: new Date() });
		return { logged: await insertOt2Docs(h.rows), deferred: h.deferred };
	} catch (e) {
		console.warn('[ot2-move-log] run history not logged:', e instanceof Error ? e.message : e);
		return { logged: 0, deferred: 1 };
	}
}

async function syncRun(robot: any, runId: string, deadline: number): Promise<{ logged: number; pending: boolean }> {
	const state = ((await Ot2MoveSync.findById(runId).lean()) as any) ?? null;
	if (state?.done) return { logged: 0, pending: false };
	const run = (await readJson(robot, `/runs/${runId}`, deadline))?.data ?? {};
	const runStatus = run.status ? String(run.status) : null;
	const names = runNames(run);
	const proto = state?.protocolName ?? (await protocolName(robot, run.protocolId, deadline));
	const from = proto ? `Run ${proto}` : `Run ${runId.slice(0, 8)}`;
	const robotRef = { _id: String(robot._id), name: String(robot.name ?? '') };
	const clockOffsetMs = await piClockOffset(robot);

	const history = await logRunHistory(robotRef, runId, from, run, clockOffsetMs);

	let cursor = Number(state?.cursor ?? 0);
	let logged = history.logged;
	let blocked = false;
	let total = Number.POSITIVE_INFINITY;
	const save = (done: boolean) =>
		Ot2MoveSync.updateOne(
			{ _id: runId },
			{ $set: { robot: robotRef, cursor, done, runStatus, protocolName: proto, runCreatedAt: run.createdAt ? new Date(run.createdAt) : null, syncedAt: new Date() } },
			{ upsert: true }
		);
	try {
		while (cursor < total && !blocked) {
			const page = await readJson(robot, `/runs/${runId}/commands?cursor=${cursor}&pageLength=${PAGE}`, deadline);
			const cmds: Ot2CommandSummary[] = Array.isArray(page?.data) ? page.data : [];
			total = Number(page?.meta?.totalLength ?? cursor + cmds.length);
			if (!cmds.length) break;
			const pick = pickLoggable(cmds, cursor, runStatus);
			logged += await insertOt2Docs(ot2Docs(robotRef, runId, from, names, pick.rows, clockOffsetMs));
			cursor = pick.cursor;
			blocked = pick.blocked;
		}
	} catch (e) {
		await save(false);
		throw e;
	}
	// An action too young to source yet keeps the run open for the next sync.
	const done = isRunEnded(runStatus) && !blocked && cursor >= total && history.deferred === 0;
	await save(done);
	return { logged, pending: !done };
}

/** Read the robot's recent runs into the Movement Log, within `budgetMs`. */
export async function syncOt2Robot(robotId: string | null | undefined, o: { budgetMs?: number; runId?: string } = {}): Promise<Ot2SyncResult> {
	if (!robotId || process.env.VITEST) return { robot: null, logged: 0, pending: false, error: null };
	const deadline = Date.now() + (o.budgetMs ?? 6000);
	let robot: any = null;
	try {
		await connectDB();
		robot = await getRobot(robotId);
		if (!robot) return { robot: null, logged: 0, pending: false, error: 'The OT-2 is not registered or not active.' };
		return await syncRobotRecord(robot, deadline, o.runId);
	} catch (e) {
		console.warn('[ot2-move-log] sync failed:', e instanceof Error ? e.message : e);
		return { robot: robot?.name ?? null, logged: 0, pending: true, error: e instanceof Error ? e.message : String(e) };
	}
}

/** syncOt2Robot on a robot record already in hand (also how a one-off script reads a robot by another address). */
export async function syncRobotRecord(robot: any, deadline: number, runId?: string): Promise<Ot2SyncResult> {
	let logged = 0;
	let pending = false;
	try {
		await connectDB();
		let runIds: string[];
		if (runId) runIds = [runId];
		else {
			const list: any[] = (await readJson(robot, '/runs', deadline))?.data ?? [];
			const since = Date.now() - RECENT_DAYS * 86_400_000;
			const recent = list.filter((r) => r?.id && (!r.createdAt || new Date(r.createdAt).getTime() >= since));
			const done = new Set(
				((await Ot2MoveSync.find({ _id: { $in: recent.map((r) => String(r.id)) }, done: true }).select('_id').lean()) as any[]).map((d) => String(d._id))
			);
			// The current run first (it is the live one), then newest first.
			runIds = recent
				.filter((r) => !done.has(String(r.id)))
				.sort((a, b) => Number(!!b.current) - Number(!!a.current) || String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
				.map((r) => String(r.id));
		}
		for (const id of runIds) {
			const r = await syncRun(robot, id, deadline);
			logged += r.logged;
			pending ||= r.pending;
		}
		return { robot: robot.name ?? null, logged, pending, error: null };
	} catch (e) {
		if (e instanceof OutOfTime) return { robot: robot?.name ?? null, logged, pending: true, error: null };
		console.warn('[ot2-move-log] sync failed:', e instanceof Error ? e.message : e);
		return { robot: robot?.name ?? null, logged, pending: true, error: e instanceof Error ? e.message : String(e) };
	}
}

/** One measured arm loop step: the play was sent at `startedAt`, the arrival check passed now. */
export async function recordArmLoopStep(o: {
	step: LoopStep;
	loopId: string;
	cart: number;
	startedAt: Date | string | null | undefined;
	plannedS: number | null | undefined;
	animation: string | null | undefined;
	user: { _id: string; username: string } | null;
}): Promise<void> {
	if (process.env.VITEST || !o.startedAt) return;
	const at = new Date(o.startedAt);
	if (!Number.isFinite(at.getTime())) return;
	const endAt = new Date();
	try {
		await connectDB();
		await RobotArmMove.create({
			device: 'arm',
			at,
			endAt,
			durationMs: Math.max(0, endAt.getTime() - at.getTime()),
			kind: 'loop_step',
			what: o.step,
			line: loopStepLine(o.step, o.cart, o.plannedS ?? null, o.animation ?? null),
			ok: true,
			error: null,
			from: 'Run',
			movedBy: o.user ? { _id: o.user._id, username: o.user.username } : null,
			loopId: o.loopId,
			cart: o.cart
		});
	} catch (err) {
		console.warn('[arm-move-log] loop step write failed:', err instanceof Error ? err.message : err);
	}
}
