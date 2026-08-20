/** KB2-29 — one plan: markdown verbatim + live spawned-task index + supersession chain. */
import { error, redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, PlanningDocument, KanbanTask } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'kanban:read');
	await connectDB();

	const plan = (await PlanningDocument.findById(params.planId).lean()) as any;
	if (!plan) throw error(404, 'Plan not found');

	const [spawned, predecessor, successor] = await Promise.all([
		KanbanTask.find({ sourceRef: `plan:${plan._id}` })
			.select('_id trackingNumber title status itemType rank tags dueDate estimateDays archived')
			.sort({ rank: 1, createdAt: 1 })
			.lean(),
		plan.supersedes
			? PlanningDocument.findById(plan.supersedes).select('_id title version').lean()
			: null,
		PlanningDocument.findOne({ supersedes: plan._id }).select('_id title version').lean()
	]);

	return {
		plan: JSON.parse(JSON.stringify(plan)),
		spawned: JSON.parse(JSON.stringify(spawned)),
		predecessor: predecessor ? JSON.parse(JSON.stringify(predecessor)) : null,
		successor: successor ? JSON.parse(JSON.stringify(successor)) : null,
		user: JSON.parse(JSON.stringify(locals.user))
	};
};
