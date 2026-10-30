/**
 * The fill profile of a robot-arm wax-fill loop: the loop's one OT-2 run read
 * back from the robot (GET /runs/{id} + its whole command log) and laid out
 * per cart and per station by $lib/robot-arm/run-profile. Cached on the
 * ArmWaxFillRun once the run is over, since the robot only keeps its last
 * runs; a running loop is profiled live every time it is asked for.
 */
import { connectDB, ArmWaxFillRun } from '$lib/server/db';
import { getRobot, robotGet } from '$lib/server/opentrons/proxy';
import { profileRun, type Ot2CommandSummary, type ProfileLandmarks, type RunProfile, type XY } from '$lib/robot-arm/run-profile';

export class FillProfileError extends Error {
	status: number;
	constructor(message: string, status = 400) {
		super(message);
		this.status = status;
	}
}

const PAGE = 100;
const MAX_COMMANDS = 20_000;
const TERMINAL = new Set(['succeeded', 'failed', 'stopped']);

export async function loopFillProfile(loopId: string, opts: { refresh?: boolean } = {}): Promise<RunProfile> {
	await connectDB();
	const loop = (await ArmWaxFillRun.findById(loopId).lean()) as any;
	if (!loop) throw new FillProfileError('Loop not found.', 404);
	const runId = String(loop.opentronsRunId ?? '');
	if (!runId) throw new FillProfileError('This loop never started an OT-2 run, so there is nothing to profile.', 409);
	if (loop.fillProfile && !opts.refresh && loop.status !== 'running') return loop.fillProfile as RunProfile;

	const robot = await getRobot(String(loop.robot?._id ?? ''));
	if (!robot) throw new FillProfileError('The OT-2 this loop ran on is not registered or not active.', 409);

	const read = async (path: string): Promise<any> => {
		let r: Response;
		try {
			r = await robotGet(robot, path);
		} catch (e) {
			throw new FillProfileError(`The OT-2 could not be read (${e instanceof Error ? e.message : String(e)}).`, 502);
		}
		if (r.status === 404) throw new FillProfileError('The robot no longer holds this run (it keeps only its most recent runs), and no profile was saved while it did.', 404);
		if (!r.ok) throw new FillProfileError(`The OT-2 answered HTTP ${r.status} for ${path}.`, 502);
		return r.json();
	};

	const run = (await read(`/runs/${runId}`))?.data ?? {};
	const commands: Ot2CommandSummary[] = [];
	let cursor = 0;
	let total = Number.POSITIVE_INFINITY;
	while (cursor < total && commands.length < MAX_COMMANDS) {
		const page = await read(`/runs/${runId}/commands?cursor=${cursor}&pageLength=${PAGE}`);
		const rows: Ot2CommandSummary[] = Array.isArray(page?.data) ? page.data : [];
		total = Number(page?.meta?.totalLength ?? rows.length);
		if (!rows.length) break;
		commands.push(...rows);
		cursor += rows.length;
	}

	const rtp: any[] = Array.isArray(run.runTimeParameters) ? run.runTimeParameters : [];
	const num = (name: string): number | null => {
		const v = Number(rtp.find((p) => p?.variableName === name)?.value);
		return Number.isFinite(v) ? v : null;
	};
	const xy = (xName: string, yName: string): XY | null => {
		const x = num(xName);
		const y = num(yName);
		return x != null && y != null && (x > 0 || y > 0) ? { x, y } : null;
	};
	const landmarks: ProfileLandmarks = { cart: xy('arm_cart_x', 'arm_cart_y'), scan: xy('arm_scan_x', 'arm_scan_y'), calibrator: xy('cal_x', 'cal_y') };

	const profile = profileRun(runId, commands, { status: run.status ?? null, startedAt: run.startedAt ?? null, completedAt: run.completedAt ?? null, landmarks });
	if (profile.status && TERMINAL.has(profile.status)) {
		await ArmWaxFillRun.updateOne({ _id: loopId }, { $set: { fillProfile: profile } }).catch(() => null);
	}
	return profile;
}
