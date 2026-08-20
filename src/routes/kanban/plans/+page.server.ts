/** KB2-29 — /kanban/plans: immortalized PlanningDocuments, newest first. */
import { redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, PlanningDocument, KanbanTask } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'kanban:read');
	await connectDB();

	const plans = (await PlanningDocument.find({})
		.select('_id title version status supersedes authoredBy filedVia context createdAt')
		.sort({ createdAt: -1 })
		.lean()) as any[];

	const counts = plans.length
		? ((await KanbanTask.aggregate([
				{ $match: { sourceRef: { $in: plans.map((p) => `plan:${p._id}`) } } },
				{
					$group: {
						_id: '$sourceRef',
						total: { $sum: 1 },
						done: { $sum: { $cond: [{ $eq: ['$status', 'done'] }, 1, 0] } }
					}
				}
			])) as any[])
		: [];
	const byRef = new Map(counts.map((c) => [c._id, c]));

	return {
		plans: JSON.parse(
			JSON.stringify(
				plans.map((p) => ({
					...p,
					spawnedTasks: byRef.get(`plan:${p._id}`)?.total ?? 0,
					spawnedDone: byRef.get(`plan:${p._id}`)?.done ?? 0
				}))
			)
		),
		user: JSON.parse(JSON.stringify(locals.user))
	};
};
