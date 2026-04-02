/**
 * GET /api/opentrons-lab/run-records — List run records with optional filters
 * Query params: robotId, manufacturingRunId, status, limit
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { connectDB, OpentronsRunRecord } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	requirePermission(locals.user, 'manufacturing:read');

	await connectDB();

	const filter: Record<string, unknown> = {};
	const robotId = url.searchParams.get('robotId');
	const manufacturingRunId = url.searchParams.get('manufacturingRunId');
	const status = url.searchParams.get('status');

	if (robotId) filter.robotId = robotId;
	if (manufacturingRunId) filter.manufacturingRunId = manufacturingRunId;
	if (status) filter.status = status;

	const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50', 10), 200);

	const records = await OpentronsRunRecord.find(filter)
		.sort({ createdAt: -1 })
		.limit(limit)
		.lean();

	return json({ data: JSON.parse(JSON.stringify(records)) });
};
