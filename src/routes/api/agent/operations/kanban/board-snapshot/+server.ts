import { json, error } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB, KanbanTask } from '$lib/server/db';
import { ALL_STATUSES, LINK_INVERSE, isKanbanStatus, type KanbanLinkType } from '$lib/shared/kanban-status';
import type { RequestHandler } from './$types';

// KB2-16: one board, every status is a column.
const COLUMNS = ALL_STATUSES;

/**
 * Board snapshot for agents. Query params (MCP-IMPROVEMENTS P2-6.4, all optional,
 * back-compat defaults):
 *   statuses=captured,ready   only these columns' tasks (columns list stays complete)
 *   includeActivity=false     drop recentActivity (big token saving)
 *   tag=Filling Line          only tasks carrying this tag (exact, case-insensitive)
 * Every task carries `links` (declared + derived, P1-4) plus `blockedBy` /
 * `blocks` convenience lists resolved to titles, and `parentTaskId`.
 */
export const GET: RequestHandler = async ({ request, url }) => {
	requireAgentApiKey(request);
	await connectDB();

	const statusesParam = url.searchParams.get('statuses');
	const statusFilter = statusesParam
		? statusesParam.split(',').map((s) => s.trim()).filter(Boolean)
		: null;
	if (statusFilter) {
		const bad = statusFilter.filter((s) => !isKanbanStatus(s));
		if (bad.length) throw error(400, `Unknown status(es): ${bad.join(', ')}`);
	}
	const includeActivity = url.searchParams.get('includeActivity') !== 'false';
	const tagParam = url.searchParams.get('tag')?.trim().toLowerCase() || null;

	// Always load the full active set for link resolution (titles of the far
	// side must resolve even when that task is filtered out of the response).
	const all = (await KanbanTask.find({ archived: { $ne: true } })
		.select('_id trackingNumber title status rank sizeClass assignee dueDate tags parentTaskId links dor itemType classOfService activityLog statusChangedAt')
		.sort({ rank: 1 })
		.lean()) as any[];
	const byId = new Map<string, any>(all.map((t) => [t._id, t]));

	// Derived inverse edges: for every stored link A→B(type), B sees A with the
	// inverse type. Built once over the whole board.
	const derived = new Map<string, Array<{ taskId: string; type: KanbanLinkType; note?: string; linkId: string }>>();
	for (const t of all) {
		for (const l of t.links ?? []) {
			const inv = LINK_INVERSE[l.type as KanbanLinkType] ?? 'relates_to';
			if (!derived.has(l.taskId)) derived.set(l.taskId, []);
			derived.get(l.taskId)!.push({ taskId: t._id, type: inv, note: l.note, linkId: l._id });
		}
	}
	const ref = (id: string) => {
		const o = byId.get(id);
		return { taskId: id, trackingNumber: o?.trackingNumber ?? null, title: o?.title ?? '(deleted or archived)', status: o?.status ?? null };
	};

	const tasksByStatus: Record<string, any[]> = {};
	const statusCounts: Record<string, number> = {};
	for (const col of COLUMNS) {
		tasksByStatus[col] = [];
		statusCounts[col] = 0;
	}

	for (const t of all) {
		const status = t.status || 'captured';
		statusCounts[status] = (statusCounts[status] || 0) + 1;
		if (statusFilter && !statusFilter.includes(status)) continue;
		if (tagParam && !(t.tags ?? []).some((x: string) => x.toLowerCase() === tagParam)) continue;

		const own = (t.links ?? []).map((l: any) => ({ linkId: l._id, type: l.type, note: l.note ?? null, direction: 'declared', ...ref(l.taskId) }));
		const inbound = (derived.get(t._id) ?? []).map((l) => ({ linkId: l.linkId, type: l.type, note: l.note ?? null, direction: 'derived', ...ref(l.taskId) }));
		const linksAll = [...own, ...inbound];
		const blockedBy = linksAll.filter((l) => l.type === 'blocked_by').map((l) => ({ ...ref(l.taskId), open: l.status !== 'done' }));
		const blocks = linksAll.filter((l) => l.type === 'blocks').map((l) => ref(l.taskId));

		if (!tasksByStatus[status]) tasksByStatus[status] = [];
		tasksByStatus[status].push({
			id: t._id,
			trackingNumber: t.trackingNumber ?? null,
			title: t.title,
			status: t.status,
			rank: t.rank ?? 0,
			itemType: t.itemType ?? 'deliverable',
			classOfService: t.classOfService ?? 'standard',
			sizeClass: t.sizeClass ?? null,
			assignee: t.assignee,
			dueDate: t.dueDate,
			tags: t.tags,
			parentTaskId: t.parentTaskId ?? null,
			dorSet: Boolean(t.dor?.deliverable),
			links: linksAll,
			blockedBy,
			blocks,
			...(includeActivity
				? {
						recentActivity: (t.activityLog || []).slice(-5).map((a: any) => ({
							action: a.action,
							details: a.details,
							createdAt: a.createdAt,
							createdBy: a.createdBy
						}))
					}
				: {})
		});
	}

	return json({
		success: true,
		data: {
			columns: COLUMNS.map((status) => ({ status, tasks: tasksByStatus[status] || [] })),
			summary: {
				total: all.length,
				byStatus: statusCounts,
				filters: { statuses: statusFilter, tag: tagParam, includeActivity }
			}
		}
	});
};
