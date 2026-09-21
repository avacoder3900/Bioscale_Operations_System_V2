import { json, error } from '@sveltejs/kit';
import { connectDB, KanbanTask } from '$lib/server/db';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { TransitionError } from '$lib/server/kanban/transition';
import { captureOptionsFromBody, captureOne } from '$lib/server/kanban/agent-shapes';
import type { RequestHandler } from './$types';

const MAX_ITEMS = 50;

/**
 * Bulk capture (MCP-IMPROVEMENTS P0-2). Semantics: PER-ITEM RESULTS, not a
 * transaction — every item is validated and created independently, in input
 * order; a bad item (e.g. a spike without a question) is rejected on its own
 * and the rest still land. Each success is audit-logged exactly like a single
 * capture. Response preserves input order and adds summary counts.
 */
export const POST: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await connectDB();

	const body = await request.json();
	const { items, actor } = body;
	if (!Array.isArray(items) || items.length === 0) throw error(400, 'items must be a non-empty array');
	if (items.length > MAX_ITEMS) throw error(400, `items must contain at most ${MAX_ITEMS} entries (got ${items.length})`);
	const actorName = typeof actor === 'string' && actor.trim() ? actor.trim() : 'agent';

	// Parent ids are validated once up front so a typo surfaces per item with a
	// clear message rather than as a generic create failure.
	const parentIds = Array.from(new Set(items.map((i: any) => i?.parentTaskId).filter((p: unknown) => typeof p === 'string' && p)));
	const knownParents = new Set(
		parentIds.length
			? ((await KanbanTask.find({ _id: { $in: parentIds } }).select('_id').lean()) as any[]).map((t) => t._id)
			: []
	);

	const results: Array<{ index: number; success: boolean; task?: any; error?: string }> = [];
	for (let index = 0; index < items.length; index++) {
		const item = items[index];
		try {
			if (item?.parentTaskId && !knownParents.has(item.parentTaskId)) {
				throw new TransitionError('NOT_FOUND', `Parent task ${item.parentTaskId} not found`);
			}
			const opts = await captureOptionsFromBody(item, { username: actorName, via: 'agent-api' });
			const task = await captureOne(opts);
			results.push({ index, success: true, task });
		} catch (e) {
			const message = e instanceof TransitionError ? e.message : e instanceof Error ? e.message : 'create failed';
			results.push({ index, success: false, error: message });
		}
	}

	const created = results.filter((r) => r.success).length;
	return json(
		{
			success: created > 0,
			data: {
				results,
				summary: { requested: items.length, created, rejected: items.length - created }
			}
		},
		{ status: created > 0 ? 201 : 400 }
	);
};
