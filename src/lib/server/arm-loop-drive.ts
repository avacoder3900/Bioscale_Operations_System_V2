/**
 * The arm Pi drives the robot-arm wax-fill loop (2026-11-06) — OPTIONAL.
 *
 * Off unless Setup's "Arm Pi Drives The Loop" is on. Then startLoop hands the
 * loop to the Pi's driver (services/robot-arm/src/server/loop_driver.py,
 * POST /ot2/loop-driver/start), which runs the SAME steps the Run tab's
 * browser runs, one at a time, through POST /api/robot-arm/wax-fill/drive →
 * runDriveStep() here → the same arm-wax-fill.ts functions the page's form
 * actions call. Every gate stays in arm-wax-fill.ts; the Pi only removes the
 * browser's hops and its 0.5 s play-end poll (it sees a play end locally).
 *
 * If the Pi cannot take the loop (switch off, Pi down, BIMS's drive endpoint
 * not reachable from the Pi), the loop stays the browser's, as before.
 */
import { env } from '$env/dynamic/private';
import { timingSafeEqual } from 'node:crypto';
import { connectDB, ArmWaxFillRun, ArmWaxFillSettings } from '$lib/server/db';
import { robotArmFetchRaw } from './robot-arm-client';
import { afterPlay, playbackActive } from './robot-arm-animation';
import {
	ArmWaxFillError,
	cycleAwaitParked,
	cycleDecide,
	cycleFail,
	cycleFailDone,
	cycleFailPrepare,
	cycleFillWait,
	cycleGrab,
	cycleGrabDone,
	cycleScanRead,
	cycleScanStart,
	cycleSkipAhead,
	cycleWithdraw,
	cycleWithdrawDone,
	failLoop,
	getLoop,
	loopFinish
} from './arm-wax-fill';

/** The BIMS address the Pi calls back. Production unless ARM_DRIVER_BIMS_URL says otherwise. */
export const DRIVER_BIMS_URL = (): string => (env.ARM_DRIVER_BIMS_URL || 'https://bioscale-operations-system-mongodb.vercel.app').replace(/\/$/, '');

/** The Pi holds ROBOT_ARM_API_KEY (the same key the /api/robot-arm/changes route takes from it). */
export function isArmPiKey(request: Request): boolean {
	const given = request.headers.get('x-api-key') ?? '';
	const expected = env.ROBOT_ARM_API_KEY ?? '';
	if (!given || !expected) return false;
	const a = Buffer.from(given);
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
}

/** The steps the Pi may ask for: exactly the Run tab's loop steps, plus the play's end check and settle. */
export const DRIVE_ACTIONS = [
	'loopState',
	'awaitParked',
	'cycleGrab',
	'cycleGrabDone',
	'cycleScanStart',
	'cycleScanRead',
	'cycleDecide',
	'cycleFillWait',
	'cycleSkipAhead',
	'cycleWithdraw',
	'cycleWithdrawDone',
	'cycleFailPrepare',
	'cycleFail',
	'cycleFailDone',
	'loopFinish',
	'failLoop',
	'playback',
	'settle'
] as const;
export type DriveAction = (typeof DRIVE_ACTIONS)[number];

const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

/**
 * One step for the Pi's driver, as the loop's starter. Refused unless the loop
 * is driven by the Pi (driver 'arm-pi'), so the endpoint can never act on a
 * loop the browser is driving. Same return shapes as the Run tab's actions.
 */
export async function runDriveStep(loopId: string, action: string, extra: Record<string, unknown> = {}): Promise<unknown> {
	if (!(DRIVE_ACTIONS as readonly string[]).includes(action)) throw new ArmWaxFillError(`Unknown drive step "${action}".`, 400);
	await connectDB();
	const d = (await ArmWaxFillRun.findById(loopId).select('driver startedBy status').lean()) as any;
	if (!d) throw new ArmWaxFillError('Loop not found.', 404);
	if (d.driver !== 'arm-pi') throw new ArmWaxFillError('This loop is driven by the Run tab, not the arm Pi.', 409);
	const user = { _id: String(d.startedBy?._id ?? 'arm-pi'), username: String(d.startedBy?.username ?? 'arm-pi') };
	switch (action as DriveAction) {
		case 'loopState':
			return { loop: plain(await getLoop(loopId)) };
		case 'awaitParked':
			return plain(await cycleAwaitParked(user, loopId));
		case 'cycleGrab':
			return plain(await cycleGrab(user, loopId));
		case 'cycleGrabDone':
			return { loop: plain(await cycleGrabDone(user, loopId)) };
		case 'cycleScanStart':
			return { loop: plain(await cycleScanStart(user, loopId)) };
		case 'cycleScanRead':
			return plain(await cycleScanRead(user, loopId));
		case 'cycleDecide':
			return { loop: plain(await cycleDecide(user, loopId)) };
		case 'cycleFillWait':
			return plain(await cycleFillWait(user, loopId));
		case 'cycleSkipAhead':
			return plain(await cycleSkipAhead(user, loopId));
		case 'cycleWithdraw':
			return plain(await cycleWithdraw(user, loopId));
		case 'cycleWithdrawDone':
			return plain(await cycleWithdrawDone(user, loopId));
		case 'cycleFailPrepare':
			return plain(await cycleFailPrepare(user, loopId));
		case 'cycleFail':
			return plain(await cycleFail(user, loopId));
		case 'cycleFailDone':
			return { loop: plain(await cycleFailDone(user, loopId)) };
		case 'loopFinish':
			return plain(await loopFinish(user, loopId));
		case 'failLoop':
			return { loop: plain(await failLoop(user, loopId, String(extra.step ?? 'unknown'), String(extra.error ?? 'failed'))) };
		case 'playback':
			return { active: plain(await playbackActive(typeof extra.runId === 'string' ? extra.runId : null)) };
		case 'settle':
			if (typeof extra.runId !== 'string' || !extra.runId) throw new ArmWaxFillError('No run.', 400);
			return { settle: plain(await afterPlay(user, extra.runId)) };
	}
}

/** Setup's switch. */
export async function armPiDrives(): Promise<boolean> {
	await connectDB();
	const s = (await ArmWaxFillSettings.findById('default').select('armPiDrives').lean()) as { armPiDrives?: boolean } | null;
	return s?.armPiDrives === true;
}

/**
 * Hand a started loop to the Pi's driver. Marks the loop 'arm-pi' FIRST (the
 * Pi's first call is loopState, which the endpoint refuses otherwise) and puts
 * it back to 'browser' when the Pi does not take it. Returns who drives.
 */
export async function startArmDriver(loopId: string): Promise<{ driver: 'arm-pi' | 'browser'; reason: string | null }> {
	await connectDB();
	await ArmWaxFillRun.updateOne({ _id: loopId }, { $set: { driver: 'arm-pi' } });
	let reason: string | null = null;
	try {
		const r = await robotArmFetchRaw('/ot2/loop-driver/start', { method: 'POST', body: { loop_id: loopId, bims_url: DRIVER_BIMS_URL() }, timeoutMs: 20_000 });
		if (r.ok) return { driver: 'arm-pi', reason: null };
		reason = r.status === 404 ? 'the arm Pi has no loop driver yet' : `the arm Pi refused (${r.status}): ${r.text.slice(0, 160)}`;
	} catch (e) {
		reason = `the arm Pi could not be reached: ${e instanceof Error ? e.message : String(e)}`;
	}
	await ArmWaxFillRun.updateOne({ _id: loopId }, { $set: { driver: 'browser', driverNote: reason } });
	return { driver: 'browser', reason };
}

/** Stop the Pi's driver after its current step (STOP RUN, Reset). Best effort; never moves anything. */
export async function stopArmDriver(loopId: string | null): Promise<void> {
	try {
		await robotArmFetchRaw('/ot2/loop-driver/stop', { method: 'POST', body: { loop_id: loopId }, timeoutMs: 5000 });
	} catch {
		/* the Pi down: nothing is being driven from it either */
	}
}

/** The Pi driver's status for the Run tab, or null when the Pi does not answer. */
export async function armDriverStatus(): Promise<Record<string, unknown> | null> {
	try {
		const r = await robotArmFetchRaw('/ot2/loop-driver/status', { timeoutMs: 4000 });
		return r.ok ? JSON.parse(r.text) : null;
	} catch {
		return null;
	}
}
