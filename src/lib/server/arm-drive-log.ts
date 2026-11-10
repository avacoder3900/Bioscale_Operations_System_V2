/**
 * Writes the arm Pi drive-step rows (2026-11-10) — see $lib/robot-arm/drive-log.
 * Never throws: a log row failing must not fail the step it describes.
 */
import { connectDB, ArmWaxFillRun } from '$lib/server/db';
import { insertOt2Docs } from './ot2-move-log';
import { robotArmFetchRaw } from './robot-arm-client';
import { answeredRow, piEventRows, piLoopEventRows, receivedRow, type DriveRow } from '$lib/robot-arm/drive-log';

type RobotRef = { _id: string; name: string } | undefined;

async function loopRobotRef(loopId: string): Promise<RobotRef> {
	try {
		await connectDB();
		const l = (await ArmWaxFillRun.findById(loopId).select('robot').lean()) as any;
		return l?.robot?._id ? { _id: String(l.robot._id), name: String(l.robot.name ?? '') } : undefined;
	} catch {
		return undefined;
	}
}

async function insertRows(rows: DriveRow[], robot: RobotRef): Promise<number> {
	if (process.env.VITEST || !rows.length) return 0;
	try {
		await connectDB();
		return await insertOt2Docs(rows.map((r) => ({ ...r, movedBy: null, robot })));
	} catch (err) {
		console.warn('[arm-drive-log] rows failed:', err instanceof Error ? err.message : err);
		return 0;
	}
}

export interface DriveRequestInfo {
	loopId: string;
	action: string;
	reqId: string | null;
	attempt: number | null;
	receivedAt: Date;
	vercelId: string | null;
}

/** The step reached BIMS. Returns the robot it looked up, for the answered row. */
export async function logDriveReceived(i: DriveRequestInfo): Promise<RobotRef> {
	const robot = await loopRobotRef(i.loopId);
	await insertRows([receivedRow(i)], robot);
	return robot;
}

/** BIMS is about to send its answer. */
export async function logDriveAnswered(i: DriveRequestInfo, o: { status: number; error: string | null; robot: RobotRef }): Promise<void> {
	await insertRows(
		[answeredRow({ ...i, answeredAt: new Date(), status: o.status, error: o.error, region: process.env.VERCEL_REGION ?? null })],
		o.robot
	);
}

/** The Pi's own log for a loop (sent when its drive ends). */
export async function recordPiDriveLog(loopId: string, events: unknown): Promise<{ rows: number }> {
	if (!Array.isArray(events)) return { rows: 0 };
	const robot = await loopRobotRef(loopId);
	return { rows: await insertRows(piEventRows(loopId, events), robot) };
}

/**
 * The Pi's handshake events for a loop that just ended (finished, failed or
 * halted), read from GET /ot2/loop/events — they live only in the Pi's memory.
 * 5 s cap; a Pi that does not answer costs the loop nothing.
 */
export async function recordPiLoopEvents(loop: any): Promise<number> {
	if (process.env.VITEST || !loop?._id || !loop.startedAt) return 0;
	try {
		const r = await robotArmFetchRaw('/ot2/loop/events?limit=2000', { timeoutMs: 5000 });
		if (!r.ok) return 0;
		const events = (JSON.parse(r.text) as { events?: unknown[] })?.events ?? [];
		const rows = piLoopEventRows({
			loopId: String(loop._id),
			runId: loop.opentronsRunId ? String(loop.opentronsRunId) : null,
			startedAt: new Date(loop.startedAt),
			endedAt: loop.endedAt ? new Date(loop.endedAt) : new Date(),
			events
		});
		const robot = loop.robot?._id ? { _id: String(loop.robot._id), name: String(loop.robot.name ?? '') } : undefined;
		return await insertRows(rows, robot);
	} catch (err) {
		console.warn('[arm-drive-log] Pi loop events not read:', err instanceof Error ? err.message : err);
		return 0;
	}
}
