/** KB2-29 — one plan: markdown verbatim + live spawned-task index + supersession chain. */
import { error, redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, PlanningDocument, KanbanTask } from '$lib/server/db';
import { deriveChains } from '$lib/server/kanban/chains';
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

	// KB2-39 — the plan's live chain (milestone DAG), task rows in dependency order.
	let chain: any = null;
	if (plan.milestoneId) {
		const { chains } = await deriveChains();
		const c = chains.find((x) => x.id === plan.milestoneId);
		if (c) {
			const rows = (await KanbanTask.find({ _id: { $in: c.order } })
				.select('_id trackingNumber title status itemType tags estimateDays sizeClass')
				.lean()) as any[];
			const byId = new Map(rows.map((r) => [String(r._id), r]));
			chain = {
				id: c.id, name: c.name, trackingNumber: c.trackingNumber, dueDate: c.dueDate,
				total: c.total, done: c.done, board: c.board, tier1: c.tier1,
				tasks: c.order
					.map((id, i) => {
						const r = byId.get(id);
						return r
							? { _id: id, position: i + 1, trackingNumber: r.trackingNumber ?? null, title: r.title, status: r.status, itemType: r.itemType ?? 'deliverable', tags: r.tags ?? [], estimateDays: r.estimateDays ?? null, sizeClass: r.sizeClass ?? null, nextUp: c.nextUp.includes(id) }
							: null;
					})
					.filter(Boolean)
			};
		}
	}

	return {
		chain: JSON.parse(JSON.stringify(chain)),
		plan: JSON.parse(JSON.stringify(plan)),
		spawned: JSON.parse(JSON.stringify(spawned)),
		predecessor: predecessor ? JSON.parse(JSON.stringify(predecessor)) : null,
		successor: successor ? JSON.parse(JSON.stringify(successor)) : null,
		user: JSON.parse(JSON.stringify(locals.user))
	};
};
