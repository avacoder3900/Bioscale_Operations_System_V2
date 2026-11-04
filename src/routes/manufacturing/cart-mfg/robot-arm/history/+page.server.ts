/**
 * Robot Arm — History: one place for what the line did.
 *
 *   ?view=runs      (default) wax-fill runs (ArmWaxFillRun), newest first
 *   ?view=sessions  raw arm sessions (RobotArmRun: every play, replay, teleop,
 *                   record, calibrate, task — paginated, filterable by type
 *                   and status), the log the old Runs tab showed.
 *
 * Both read BIMS only, so History works while the Pi is down.
 */
import { redirect } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection';
import { ArmWaxFillRun, RobotArmRun } from '$lib/server/db/models';
import { requirePermission } from '$lib/server/permissions';
import { loopView, type LoopView } from '$lib/server/arm-wax-fill';
import type { PageServerLoad } from './$types';

const PAGE_SIZE = 50;
const VALID_TYPES = new Set(['teleop', 'record', 'replay', 'calibrate', 'task']);
const VALID_STATUSES = new Set(['pending', 'running', 'completed', 'failed', 'cancelled']);

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();

	const view = url.searchParams.get('view') === 'sessions' ? 'sessions' : 'runs';
	const typeFilter = url.searchParams.get('type');
	const statusFilter = url.searchParams.get('status');
	const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10));

	if (view === 'runs') {
		const [rows, total] = await Promise.all([
			ArmWaxFillRun.find({})
				.sort({ createdAt: -1 })
				.skip((page - 1) * PAGE_SIZE)
				.limit(PAGE_SIZE)
				.lean(),
			ArmWaxFillRun.countDocuments({})
		]);
		const loops: LoopView[] = (rows as any[]).map(loopView);
		return {
			view,
			loops,
			runs: [] as unknown[],
			total,
			page,
			pageSize: PAGE_SIZE,
			filters: { type: null as string | null, status: null as string | null }
		};
	}

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
		view,
		loops: [] as LoopView[],
		runs: JSON.parse(JSON.stringify(runs)) as unknown[],
		total,
		page,
		pageSize: PAGE_SIZE,
		filters: { type: typeFilter, status: statusFilter }
	};
};
