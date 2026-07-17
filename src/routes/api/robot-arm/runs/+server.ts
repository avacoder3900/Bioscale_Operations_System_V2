/**
 * Read-only run list. Used to verify webhook ingestion before the
 * /manufacturing/robot-arm UI lands. Same agent-key auth as the rest of
 * the robot-arm endpoints — this is not a user-facing page.
 */
import { json } from '@sveltejs/kit';
import { connectDB, RobotArmRun } from '$lib/server/db';
import { requireRobotArmAgentKey } from '$lib/server/api-auth';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ request, url }) => {
	requireRobotArmAgentKey(request);
	await connectDB();

	const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 200);

	const runs = await RobotArmRun.find()
		.select('_id type status startedAt endedAt triggeredBy parameters result')
		.sort({ startedAt: -1 })
		.limit(limit)
		.lean();

	return json({ runs: JSON.parse(JSON.stringify(runs)) });
};
