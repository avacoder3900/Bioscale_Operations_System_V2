/**
 * Robot Arm — full run log (paginated, filterable).
 */
import { redirect } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection';
import { RobotArmRun } from '$lib/server/db/models';
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad } from './$types';

const PAGE_SIZE = 50;
const VALID_TYPES = new Set(['teleop', 'record', 'replay', 'calibrate']);
const VALID_STATUSES = new Set(['pending', 'running', 'completed', 'failed', 'cancelled']);

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();

	const typeFilter = url.searchParams.get('type');
	const statusFilter = url.searchParams.get('status');
	const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10));

	const query: Record<string, unknown> = {};
	if (typeFilter && VALID_TYPES.has(typeFilter)) query.type = typeFilter;
	if (statusFilter && VALID_STATUSES.has(statusFilter)) query.status = statusFilter;

	const [runs, total] = await Promise.all([
		RobotArmRun.find(query)
			.select('_id runId type status startedAt endedAt triggeredBy parameters lotId')
			.sort({ createdAt: -1 })
			.skip((page - 1) * PAGE_SIZE)
			.limit(PAGE_SIZE)
			.lean(),
		RobotArmRun.countDocuments(query)
	]);

	return {
		runs: JSON.parse(JSON.stringify(runs)),
		total,
		page,
		pageSize: PAGE_SIZE,
		filters: { type: typeFilter, status: statusFilter }
	};
};
