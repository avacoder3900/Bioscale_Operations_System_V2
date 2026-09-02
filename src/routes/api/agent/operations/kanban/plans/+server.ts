import { json, error } from '@sveltejs/kit';
import { connectDB, PlanningDocument, KanbanTask, AuditLog, generateId } from '$lib/server/db';
import { requireAgentApiKey } from '$lib/server/api-auth';
import type { RequestHandler } from './$types';

/**
 * KB2-27 — PlanningDocuments over the agent API (kanban_file_plan /
 * kanban_list_plans). A plan is filed FIRST, then the session captures tasks
 * with `sourceRef: 'plan:<id>'` so provenance is atomic with the import.
 */

/** GET — list plans newest-first, with spawned-task progress. */
export const GET: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await connectDB();

	const plans = (await PlanningDocument.find({})
		.select('_id title version status supersedes authoredBy filedVia context createdAt milestoneId')
		.sort({ createdAt: -1 })
		.lean()) as any[];

	// Spawned-task progress per plan — one aggregate, not N queries.
	const counts = (await KanbanTask.aggregate([
		{ $match: { sourceRef: { $in: plans.map((p) => `plan:${p._id}`) } } },
		{
			$group: {
				_id: '$sourceRef',
				total: { $sum: 1 },
				done: { $sum: { $cond: [{ $eq: ['$status', 'done'] }, 1, 0] } }
			}
		}
	])) as any[];
	const byRef = new Map(counts.map((c) => [c._id, c]));

	return json({
		success: true,
		data: plans.map((p) => ({
			...p,
			spawnedTasks: byRef.get(`plan:${p._id}`)?.total ?? 0,
			spawnedDone: byRef.get(`plan:${p._id}`)?.done ?? 0
		}))
	});
};

/** POST — file a finalized plan (content verbatim). Supersession flips the old plan. */
export const POST: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await connectDB();

	const body = await request.json();
	const { title, content, version, context, supersedes, actor, milestoneId } = body;
	if (!title?.trim()) throw error(400, 'title is required');
	if (!content?.trim()) throw error(400, 'content (the full markdown, verbatim) is required');
	const actorName = typeof actor === 'string' && actor.trim() ? actor.trim() : 'agent';

	if (supersedes) {
		const prior = await PlanningDocument.findById(supersedes).lean();
		if (!prior) throw error(404, `Plan to supersede (${supersedes}) not found`);
	}

	// KB2-39: the milestone this plan workshopped — the plan ↔ chain link.
	let milestone: any = null;
	if (typeof milestoneId === 'string' && milestoneId.trim()) {
		milestone = await KanbanTask.findById(milestoneId.trim()).select('_id title itemType').lean();
		if (!milestone) throw error(404, `milestoneId ${milestoneId} not found`);
		if (milestone.itemType !== 'milestone') {
			throw error(400, `milestoneId ${milestoneId} is itemType '${milestone.itemType}', not a milestone`);
		}
	}

	const plan = await PlanningDocument.create({
		_id: generateId(),
		title: title.trim(),
		version: typeof version === 'string' ? version.trim() : undefined,
		content,
		context: typeof context === 'string' ? context.trim() : undefined,
		status: 'active',
		supersedes: supersedes || undefined,
		authoredBy: actorName,
		filedVia: 'mcp',
		milestoneId: milestone ? String(milestone._id) : undefined
	});

	if (supersedes) {
		await PlanningDocument.updateOne({ _id: supersedes }, { $set: { status: 'superseded' } });
	}

	await AuditLog.create({
		_id: generateId(),
		tableName: 'planning_documents',
		recordId: plan._id,
		action: 'INSERT',
		newData: { title: plan.title, version: plan.version, supersedes: supersedes || null, milestoneId: plan.milestoneId ?? null },
		changedBy: actorName,
		changedAt: new Date()
	});

	return json(
		{
			success: true,
			data: {
				id: plan._id,
				title: plan.title,
				version: plan.version ?? null,
				sourceRef: `plan:${plan._id}`,
				milestoneId: plan.milestoneId ?? null,
				chainName: milestone ? milestone.title : null,
				note: `Filed. Capture this plan's tasks with sourceRef "plan:${plan._id}" so provenance links back here.`
			}
		},
		{ status: 201 }
	);
};
