/**
 * KB2-06 — Flow metrics view. Signal cards and Work Item Age come from the
 * KB2-05 module, which enforces the no-per-person constraint at the query
 * layer.
 *
 * KB2-14 — capacity (WIP-by-class vs allocation targets) and the replenishment
 * event history moved here from the retired Replenish page. (Event history
 * names the committer — that is decision attribution, not a productivity
 * aggregate.)
 *
 * KB2-15 — the Analytics page is retired into this one: person-free historical
 * charts (CFD, throughput, cycle scatter, aging, time-in-status, per-project,
 * source mix) from flow-history.ts, driven by ?range=; plus the daily WIP
 * timeline (coordination view, cross-board by design) from wip-timeline.ts,
 * driven by ?day= and ?tz=. The per-assignee table and creator-mix donut were
 * deleted outright (KB2-00 decision #12).
 */
import { redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, AuditLog } from '$lib/server/db';
import { flowMetrics } from '$lib/server/kanban/flow-metrics';
import { replenishmentStatus } from '$lib/server/kanban/replenish';
import { loadFlowHistory, parseRange } from '$lib/server/kanban/flow-history';
import { loadWipTimeline } from '$lib/server/kanban/wip-timeline';
import type { KanbanBoard } from '$lib/shared/kanban-status';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'kanban:read');
	await connectDB();
	const board: KanbanBoard = url.searchParams.get('board') === 'software' ? 'software' : 'ops';
	const range = parseRange(url.searchParams.get('range'));
	const day = url.searchParams.get('day');
	const tzRaw = url.searchParams.get('tz');
	const tzOffsetMin = tzRaw !== null && Number.isFinite(Number(tzRaw)) ? Number(tzRaw) : 0;

	const [metrics, status, history, wipTimeline] = await Promise.all([
		flowMetrics(board),
		replenishmentStatus(board),
		loadFlowHistory(board, range),
		loadWipTimeline(day, tzOffsetMin)
	]);

	// Recent replenishment events — the inspectable decision records.
	// tableName narrows to the {tableName, recordId} compound index — without it
	// this regex full-scans the audit log (Atlas query-targeting alert, 2026-07-31).
	const events = (await AuditLog.find({
		tableName: 'kanban_tasks',
		recordId: { $regex: /^replenishment:/ },
		'newData.board': board
	})
		.sort({ changedAt: -1 })
		.limit(10)
		.lean()) as any[];

	return {
		board,
		metrics: JSON.parse(JSON.stringify(metrics)),
		history: JSON.parse(JSON.stringify(history)),
		wipTimeline: JSON.parse(JSON.stringify(wipTimeline)),
		capacity: JSON.parse(
			JSON.stringify({
				wipByClassOfService: status.wipByClassOfService,
				allocationTargetsPct: status.allocationTargetsPct
			})
		),
		events: JSON.parse(
			JSON.stringify(
				events.map((e) => ({
					id: e._id,
					by: e.changedBy,
					at: e.changedAt,
					promotedCount: e.newData?.promoted?.length ?? 0,
					rejectedCount: e.newData?.rejected?.length ?? 0,
					note: e.newData?.note ?? null
				}))
			)
		)
	};
};

export const config = { maxDuration: 60 };
