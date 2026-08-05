/**
 * KB2-06 — Flow metrics view. Everything comes from the KB2-05 module, which
 * enforces the no-per-person constraint at the query layer: nothing on this
 * screen names a person, by construction.
 *
 * KB2-14 — capacity (WIP-by-class vs allocation targets) and the replenishment
 * event history moved here from the retired Replenish page: flow information
 * lives with the rest of the flow data. (Event history names the committer —
 * that is decision attribution, not a productivity aggregate.)
 */
import { redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, AuditLog } from '$lib/server/db';
import { flowMetrics } from '$lib/server/kanban/flow-metrics';
import { replenishmentStatus } from '$lib/server/kanban/replenish';
import type { KanbanBoard } from '$lib/shared/kanban-status';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'kanban:read');
	await connectDB();
	const board: KanbanBoard = url.searchParams.get('board') === 'software' ? 'software' : 'ops';

	const metrics = await flowMetrics(board);
	const status = await replenishmentStatus(board);

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
