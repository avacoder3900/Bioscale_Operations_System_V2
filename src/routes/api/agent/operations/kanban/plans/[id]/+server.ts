import { json, error } from '@sveltejs/kit';
import { connectDB, PlanningDocument, KanbanTask } from '$lib/server/db';
import { requireAgentApiKey } from '$lib/server/api-auth';
import type { RequestHandler } from './$types';

/** KB2-27 — one plan: the markdown verbatim + a live index of spawned tasks. */
export const GET: RequestHandler = async ({ request, params }) => {
	requireAgentApiKey(request);
	await connectDB();

	const plan = (await PlanningDocument.findById(params.id).lean()) as any;
	if (!plan) throw error(404, 'Plan not found');

	const spawned = (await KanbanTask.find({ sourceRef: `plan:${plan._id}` })
		.select('_id trackingNumber title status itemType rank tags estimateDays dueDate archived')
		.sort({ rank: 1, createdAt: 1 })
		.lean()) as any[];

	const successor = (await PlanningDocument.findOne({ supersedes: plan._id })
		.select('_id title version')
		.lean()) as any;

	return json({
		success: true,
		data: {
			...plan,
			spawnedTasks: spawned,
			supersededBy: successor ? { id: successor._id, title: successor.title, version: successor.version ?? null } : null
		}
	});
};
