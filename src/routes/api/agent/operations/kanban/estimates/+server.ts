import { json, error } from '@sveltejs/kit';
import { connectDB, KanbanTask, AuditLog, generateId } from '$lib/server/db';
import { requireAgentApiKey } from '$lib/server/api-auth';
import type { RequestHandler } from './$types';

/**
 * KB2-32 — kanban_set_estimates: bulk estimate/effort writes for the workshop
 * hot loop (the v4 worksheet took ~50 sequential kanban_update_task calls and
 * hit per-turn tool caps twice). 1–50 entries, per-item results, one audit row
 * per applied item. `null` clears a field; omitted leaves it alone.
 */
export const POST: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await connectDB();

	const body = await request.json();
	const { items, actor } = body;
	if (!Array.isArray(items) || items.length < 1 || items.length > 50) {
		throw error(400, 'items must be an array of 1–50 { taskId, estimateDays?, effortDays? } entries');
	}
	const actorName = typeof actor === 'string' && actor.trim() ? actor.trim() : 'agent';
	const now = new Date();

	const validDays = (v: unknown) => v === null || (typeof v === 'number' && v > 0);
	const results: { taskId: string; ok: boolean; error?: string; estimateDays?: number | null; effortDays?: number | null }[] = [];

	for (const item of items) {
		const taskId = item?.taskId?.toString();
		if (!taskId) { results.push({ taskId: String(item?.taskId ?? '?'), ok: false, error: 'missing taskId' }); continue; }
		if (item.estimateDays === undefined && item.effortDays === undefined) {
			results.push({ taskId, ok: false, error: 'nothing to set — provide estimateDays and/or effortDays' });
			continue;
		}
		if (!validDays(item.estimateDays ?? null) || !validDays(item.effortDays ?? null)) {
			results.push({ taskId, ok: false, error: 'estimateDays/effortDays must be positive numbers (or null to clear)' });
			continue;
		}
		const task: any = await KanbanTask.findById(taskId).select('estimateDays effortDays title').lean();
		if (!task) { results.push({ taskId, ok: false, error: 'not found' }); continue; }

		const $set: Record<string, unknown> = {};
		if (item.estimateDays !== undefined) $set.estimateDays = item.estimateDays;
		if (item.effortDays !== undefined) $set.effortDays = item.effortDays;
		await KanbanTask.updateOne({ _id: taskId }, { $set });
		await AuditLog.create({
			_id: generateId(),
			tableName: 'kanban_tasks',
			recordId: taskId,
			action: 'UPDATE',
			oldData: { estimateDays: task.estimateDays ?? null, effortDays: task.effortDays ?? null },
			newData: { ...$set, via: 'kanban_set_estimates' },
			changedBy: actorName,
			changedAt: now
		});
		results.push({
			taskId,
			ok: true,
			...(item.estimateDays !== undefined ? { estimateDays: item.estimateDays } : {}),
			...(item.effortDays !== undefined ? { effortDays: item.effortDays } : {})
		});
	}

	const applied = results.filter((r) => r.ok).length;
	return json({ success: true, data: { applied, rejected: results.length - applied, results } });
};
