/** KB2-29 — /kanban/plans: immortalized PlanningDocuments, newest first. */
import { redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, PlanningDocument, KanbanTask } from '$lib/server/db';
import { deriveChains } from '$lib/server/kanban/chains';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'kanban:read');
	await connectDB();

	const plans = (await PlanningDocument.find({})
		.select('_id title version status supersedes authoredBy filedVia context createdAt milestoneId')
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
	// KB2-39 — live chain progress for plans linked to a milestone.
	const { chains } = await deriveChains();
	const chainOf = (id: string | undefined) => (id ? chains.find((c) => c.id === id) ?? null : null);

	return {
		plans: JSON.parse(
			JSON.stringify(
				plans.map((p) => {
					const c = chainOf(p.milestoneId);
					return {
						...p,
						spawnedTasks: byRef.get(`plan:${p._id}`)?.total ?? 0,
						spawnedDone: byRef.get(`plan:${p._id}`)?.done ?? 0,
						chain: c ? { id: c.id, name: c.name, dueDate: c.dueDate, total: c.total, done: c.done, board: c.board, tier1: c.tier1, nextUp: c.nextUp.length } : null
					};
				})
			)
		),
		user: JSON.parse(JSON.stringify(locals.user))
	};
};
