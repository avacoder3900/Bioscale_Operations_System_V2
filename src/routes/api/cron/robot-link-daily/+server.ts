/**
 * Daily connectivity rollup (OT2-LOG-1 L5): one robot_link_daily document per
 * active robot per UTC day, from robot_link_samples + ot2_direct_calls +
 * audit_log. Registered in vercel.json at 00:10 UTC for yesterday; idempotent
 * (upsert by {robotId, day}), so it can be re-run for any day:
 *
 *   GET /api/cron/robot-link-daily?day=YYYY-MM-DD   (default: yesterday UTC)
 *   optional robotId=<id> to compute one robot.
 *
 * Auth: CRON_SECRET Bearer or the agent API key, like the other crons.
 * The math is in $lib/server/services/robot-link/rollup.ts (unit-tested);
 * this route only loads the day's rows and upserts the result.
 *
 * firstProbeMisses: no audit action records a first-probe miss today (that
 * lives in run comments, out of scope here), so it is written as 0 until one
 * exists — see FIRST_PROBE_MISS_ACTION.
 */
import { json, error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { requireAgentApiKey } from '$lib/server/api-auth';
import {
	connectDB,
	generateId,
	AuditLog,
	OpentronsRobot,
	Ot2DirectCall,
	RobotLinkDaily,
	RobotLinkSample
} from '$lib/server/db';
import { bridgeDeviceIdForRobot } from '$lib/server/opentrons/proxy';
import {
	computeDailyRollup,
	dayWindow,
	yesterdayUtc,
	type DirectCallRow,
	type SampleRow
} from '$lib/server/services/robot-link/rollup';
import type { RequestHandler } from './$types';

export const config = { maxDuration: 60 };

/** Set this when a first-probe-miss audit action exists; until then the count is 0. */
const FIRST_PROBE_MISS_ACTION: string | null = null;

function authenticate(request: Request): void {
	const auth = request.headers.get('authorization')?.replace('Bearer ', '');
	if (env.CRON_SECRET && auth === env.CRON_SECRET) return;
	requireAgentApiKey(request);
}

async function rollupRobot(robot: { _id: string; name?: string; bridgeDeviceId?: string }, day: string, start: Date, end: Date) {
	const robotId = String(robot._id);
	const deviceId = bridgeDeviceIdForRobot(robot);
	const inDay = { $gte: start, $lt: end };

	// Samples written before the device mapped to a robot carry robotId null;
	// the deviceId branch picks those up too.
	const samples = (await RobotLinkSample.find({ at: inDay, $or: [{ robotId }, { deviceId }] })
		.select('at source tailscale.direct bims.pollRttMs daemon.version paths')
		.sort({ at: 1 })
		.lean()) as unknown as SampleRow[];
	const directCalls = (await Ot2DirectCall.find({ robotId, at: inDay }).select('ok latencyMs').lean()) as unknown as DirectCallRow[];
	const [resyncs, bridgeJobErrors, firstProbeMisses] = await Promise.all([
		AuditLog.countDocuments({ tableName: 'opentrons_robots', recordId: robotId, action: 'run_start_auto_resync', changedAt: inDay }),
		// bridge_job_result rows are stamped changedBy: deviceId (indexed with changedAt).
		AuditLog.countDocuments({ changedBy: deviceId, action: 'bridge_job_result', 'newData.ok': false, changedAt: inDay }),
		FIRST_PROBE_MISS_ACTION
			? AuditLog.countDocuments({ recordId: robotId, action: FIRST_PROBE_MISS_ACTION, changedAt: inDay })
			: Promise.resolve(0)
	]);

	const rollup = computeDailyRollup({ samples, directCalls, resyncs, bridgeJobErrors, firstProbeMisses });
	await RobotLinkDaily.updateOne(
		{ robotId, day },
		{ $set: { ...rollup, computedAt: new Date() }, $setOnInsert: { _id: generateId() } },
		{ upsert: true }
	);
	return { robotId, name: robot.name ?? null, deviceId, ...rollup };
}

async function run(request: Request, url: URL) {
	authenticate(request);
	const startedAt = Date.now();

	const day = url.searchParams.get('day') ?? yesterdayUtc();
	const window = dayWindow(day);
	if (!window) throw error(400, 'day must be YYYY-MM-DD');
	const onlyRobot = url.searchParams.get('robotId');

	await connectDB();
	const robots = (await OpentronsRobot.find({ isActive: { $ne: false }, ...(onlyRobot ? { _id: onlyRobot } : {}) })
		.select('_id name bridgeDeviceId')
		.lean()) as { _id: string; name?: string; bridgeDeviceId?: string }[];

	const results: Array<Record<string, unknown>> = [];
	const failed: { robotId: string; error: string }[] = [];
	for (const robot of robots) {
		try {
			results.push(await rollupRobot(robot, day, window.start, window.end));
		} catch (err) {
			failed.push({ robotId: String(robot._id), error: (err as Error).message });
		}
	}

	console.log('[robot-link] daily', JSON.stringify({ day, robots: results.length, failed: failed.length, durationMs: Date.now() - startedAt }));
	return json({
		ok: failed.length === 0,
		day,
		robots: results,
		failed,
		firstProbeMissesNote: FIRST_PROBE_MISS_ACTION ? null : 'no first-probe-miss audit action exists yet; written as 0',
		durationMs: Date.now() - startedAt
	});
}

export const GET: RequestHandler = ({ request, url }) => run(request, url);
export const POST: RequestHandler = ({ request, url }) => run(request, url);
