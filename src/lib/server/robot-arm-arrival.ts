/**
 * Arrival and Pose Saved rows in the Movement Log (2026-11-10).
 *
 * Arrival: once a play has ended, the arm is read until it stands still and
 * one row says, per servo, where the play's last frame sent it, where it
 * stopped, how far it was asked to go and went, and the load holding it
 * there; plus the servos' own registers (goal register, current, error
 * flags, gains) when the Pi has GET /servos/state. Written from both ends
 * of a play: afterPlay (the page saw it finish) and the Pi's replay.stop
 * webhook (works with no page open); the row id is `arrival-<runId>`, so
 * whichever comes second finds it there and stops.
 *
 * Pose Saved: every pose save, edit and duplicate, with the numbers that
 * changed and where the arm was at that moment, so a pose saved with a goal
 * the arm never reached (slider 2220, arm 2244 on 2026-11-10) shows.
 *
 * Never throws: a play or save that happened must not fail because its log
 * row did not.
 */
import { connectDB } from './db/connection';
import { RobotArmMove, RobotArmMoveSet, RobotArmPose, RobotArmSequence } from './db/models';
import { afterResponse, readServoRegisters, readServoTrace, readServosTimed, type TimedReading } from './robot-arm-client';
import { currentArmActor } from './robot-arm-move-log';
import { isSettled, type ServoReading } from '$lib/robot-arm/move-log';
import {
	arrivalLine,
	arrivalReport,
	poseSaveLine,
	poseSaveReport,
	registerNote,
	servoRegisterStates,
	servoTraceFrom,
	shakeNote,
	traceMotion,
	type ServoMotion,
	type ServoTrace,
	type PoseSaveAction
} from '$lib/robot-arm/arrival';

/** The Pi answers 409 while the play's session still owns the bus; wait this long for it to let go. */
const BUS_WAIT_MS = 12_000;
/** Then this long for the arm to stand still. */
const SETTLE_CAP_MS = 4_000;
const POLL_MS = 300;
/** The fast trace on the Pi right after a play (2026-11-11): long enough to see a shake die out or not. */
const TRACE_MS = 3000;
const TRACE_HZ = 50;
/** The play row is written once the Pi answers (a Pi recording's after its read-back): look for it this long. */
const PLAY_ROW_WAIT_MS = 4_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const arrivalId = (runId: string) => `arrival-${runId}`;
const inFlight = new Set<string>();

type Who = { _id?: string; username?: string } | null;

interface PlayRow {
	_id: string;
	at: Date;
	what?: string | null;
	from?: string | null;
	movedBy?: Who;
	frames?: { goals?: (number | null)[][] } | null;
}

async function findPlayRow(runId: string): Promise<PlayRow | null> {
	const until = Date.now() + PLAY_ROW_WAIT_MS;
	for (;;) {
		const row = (await RobotArmMove.findOne({ kind: 'play', runId, at: { $gte: new Date(Date.now() - 6 * 3600_000) } })
			.select('_id at what from movedBy frames.goals')
			.lean()) as PlayRow | null;
		if (row || Date.now() > until) return row;
		await sleep(500);
	}
}

/** The pose / move set / sequence whose lastPlay is this run: its end target and pose. */
async function findPlayedDoc(runId: string): Promise<{ name: string | null; poseId: string | null; target: number[] | null } | null> {
	for (const m of [RobotArmPose, RobotArmMoveSet, RobotArmSequence] as (typeof RobotArmPose)[]) {
		const d = (await m.findOne({ 'lastPlay.runId': runId }).select('name lastPlay.end').lean()) as any;
		if (d) {
			const t = d.lastPlay?.end?.target;
			return { name: d.name ?? null, poseId: d.lastPlay?.end?.poseId || null, target: Array.isArray(t) && t.length ? t.map(Number) : null };
		}
	}
	return null;
}

interface Arrived {
	last: TimedReading | null;
	settledMs: number | null;
	note: string | null;
	trace: ServoTrace | null;
	motion: ServoMotion[] | null;
	traceError: string | null;
}

/**
 * The fast trace first, so it starts on the Pi the moment the play lets go of the bus (409 = still
 * held: retry). Then one full read. Without the trace route (an older Pi), poll until it stands still.
 */
async function readArrived(): Promise<Arrived> {
	const busUntil = Date.now() + BUS_WAIT_MS;
	let trace: ServoTrace | null = null;
	let traceError: string | null = null;
	while (Date.now() < busUntil) {
		const r = await readServoTrace(TRACE_MS, TRACE_HZ);
		trace = servoTraceFrom(r.raw);
		if (trace) break;
		traceError = r.error ?? 'GET /servos/trace gave no samples';
		if (!/409/.test(traceError)) break;
		await sleep(POLL_MS);
	}
	if (trace) {
		traceError = null;
		const motion = traceMotion(trace);
		const last = await readServosTimed();
		const steady = motion.map((m) => m.steadyAfterS);
		const settledMs = steady.every((s) => s != null) ? Math.round(Math.max(...(steady as number[])) * 1000) : null;
		const note = [trace.stopped ? `Trace Stopped: ${trace.stopped}` : null, settledMs == null ? 'Still Moving' : null].filter(Boolean).join('  ') || null;
		return { last, settledMs, note, trace, motion, traceError: null };
	}
	return { ...(await pollArrived(busUntil)), trace: null, motion: null, traceError };
}

async function pollArrived(busUntil: number): Promise<{ last: TimedReading | null; settledMs: number | null; note: string | null }> {
	let last: TimedReading | null = null;
	while (Date.now() < busUntil) {
		last = await readServosTimed();
		if (last.readings) break;
		await sleep(POLL_MS);
	}
	if (!last?.readings) return { last, settledMs: null, note: 'Bus Busy' };
	const firstAt = last.at;
	let prev: ServoReading[] = last.readings;
	while (Date.now() - firstAt < SETTLE_CAP_MS) {
		await sleep(POLL_MS);
		const r = await readServosTimed();
		if (!r.readings) continue;
		last = r;
		if (isSettled(prev, r.readings, null)) return { last, settledMs: r.at - firstAt, note: null };
		prev = r.readings;
	}
	return { last, settledMs: null, note: 'Still Moving' };
}

/** Write the play's Arrival row (once per run). `source` says which end of the play asked. */
export async function logPlayArrival(runId: string, source: 'after_play' | 'replay_stop'): Promise<void> {
	if (process.env.VITEST || !runId) return;
	const id = arrivalId(runId);
	if (inFlight.has(id)) return;
	inFlight.add(id);
	try {
		await connectDB();
		if (await RobotArmMove.exists({ _id: id })) return;
		const [play, doc] = await Promise.all([findPlayRow(runId), findPlayedDoc(runId)]);
		const frames = play?.frames?.goals ?? null;
		const target = (frames?.length ? frames[frames.length - 1] : null) ?? doc?.target ?? null;
		// Not a play BIMS logged (a fires-only run, a task): nothing to compare.
		if (!target) return;
		const before = play
			? ((await RobotArmMove.findOne({ kind: 'reading_before', moveId: play._id }).select('readings').lean()) as { readings?: ServoReading[] } | null)
			: null;
		const from = before?.readings?.length
			? target.map((_, i) => before.readings!.find((r) => r.id === i + 1)?.position ?? null)
			: (frames?.[0] ?? null);

		const read = await readArrived();
		let { last, note } = read;
		const { settledMs } = read;
		// Another play started before the arm could be read: that reading is the next play's, not this one's.
		if (play && last?.readings && (await RobotArmMove.exists({ kind: 'play', _id: { $ne: play._id }, at: { $gt: play.at, $lt: new Date(last.at) } }))) {
			last = { ...last, readings: null, error: 'The next play started before this one could be read' };
			note = 'Next Play Started';
		}
		const regs = last?.readings ? await readServoRegisters() : { raw: null, error: null };
		const states = servoRegisterStates(regs.raw);
		const report = arrivalReport(target, last?.readings ?? null, from);
		const title = play?.what ?? doc?.name ?? null;
		const notes = [note, shakeNote(read.motion), registerNote(states, target)].filter(Boolean).join('  ') || null;
		const goals: Record<string, number> = {};
		target.forEach((v, i) => {
			if (typeof v === 'number') goals[String(i + 1)] = v;
		});

		if (await RobotArmMove.exists({ _id: id })) return;
		await RobotArmMove.create({
			_id: id,
			device: 'arm',
			at: new Date(last?.at ?? Date.now()),
			kind: 'arrival',
			servo: null,
			goal: null,
			delta: null,
			goals,
			what: title,
			line: arrivalLine(title, report, { settledMs, note: notes }),
			ok: !!last?.readings,
			error: last?.error ? last.error.slice(0, 300) : null,
			// Play start to the arrival read.
			durationMs: play && last ? last.at - new Date(play.at).getTime() : null,
			from: play?.from ?? null,
			movedBy: play?.movedBy ?? null,
			runId,
			moveId: play?._id,
			readings: last?.readings ?? null,
			arrival: { ...report, motion: read.motion },
			trace: read.trace ?? undefined,
			servoState: states,
			poseId: doc?.poseId ?? undefined,
			settledMs,
			detail: { source, registersError: regs.error ? regs.error.slice(0, 200) : null, traceError: read.traceError ? read.traceError.slice(0, 200) : null }
		});
	} catch (err) {
		// 11000: the other end of the play wrote it first.
		if ((err as { code?: number }).code !== 11000) console.warn('[arm-arrival] write failed:', err instanceof Error ? err.message : err);
	} finally {
		inFlight.delete(id);
	}
}

/** logPlayArrival after the response (Vercel waitUntil), so the caller does not wait for the arm to settle. */
export const logPlayArrivalLater = (runId: string, source: 'after_play' | 'replay_stop'): void => afterResponse(logPlayArrival(runId, source));

/**
 * A Pose Saved row: what the save stored and where the arm was. Runs after
 * the response, so the save never waits for the Pi. A busy bus (a leader
 * session) leaves the arm Not Read.
 */
export function logPoseSave(o: {
	user: Who;
	action: PoseSaveAction;
	poseId: string;
	name: string;
	before: number[] | null;
	after: number[];
	basis: string;
	/** Where the numbers came from: sliders, arm, leader, a duplicated pose's name. */
	source: string | null;
	fromPose?: string | null;
}): void {
	if (process.env.VITEST) return;
	const actor = currentArmActor();
	afterResponse(
		(async () => {
			try {
				const r = await readServosTimed();
				const report = poseSaveReport(o.action, o.before, o.after, r.readings);
				const goals: Record<string, number> = {};
				o.after.forEach((v, i) => (goals[String(i + 1)] = v));
				await connectDB();
				await RobotArmMove.create({
					device: 'arm',
					at: new Date(r.at),
					kind: 'pose_save',
					servo: null,
					goals,
					what: o.name,
					line: poseSaveLine(o.name, report, { from: o.fromPose ?? null }),
					ok: true,
					error: r.error ? r.error.slice(0, 300) : null,
					durationMs: r.ms,
					from: actor?.from ?? null,
					movedBy: actor?.user ? { _id: actor.user._id, username: actor.user.username } : o.user ? { _id: o.user._id, username: o.user.username } : null,
					readings: r.readings,
					poseId: o.poseId,
					poseSave: { ...report, before: o.before, after: o.after, basis: o.basis, source: o.source }
				});
			} catch (err) {
				console.warn('[arm-arrival] pose save row failed:', err instanceof Error ? err.message : err);
			}
		})()
	);
}
