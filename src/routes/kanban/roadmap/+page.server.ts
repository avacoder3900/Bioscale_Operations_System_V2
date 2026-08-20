/**
 * KB2-29 — /kanban/roadmap: the chronological view.
 *
 * One time axis split by today's line — PAST IS FACT (actual wip→done spans
 * from real stamps, last 8 weeks), FUTURE IS MATH (the KB2-28 derived
 * schedule). Lanes are TAGS, never people (KB2-00 decision #12: a per-person
 * past timeline would visually reconstruct the forbidden per-person history
 * aggregates). Plus the daily drivers: per-milestone countdown + must-start.
 */
import { redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, KanbanTask } from '$lib/server/db';
import { computeRoadmap } from '$lib/server/kanban/schedule';
import type { PageServerLoad } from './$types';

const DAY_MS = 24 * 60 * 60 * 1000;

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'kanban:read');
	await connectDB();

	const roadmap = await computeRoadmap();

	// Past-fact spans: last 8 weeks of actual work. Done (wip→completed) and
	// in-flight (wip→now). Lane = first tag (same rule as WIP-timeline color).
	const since = new Date(Date.now() - 56 * DAY_MS);
	const past = (await KanbanTask.find({
		$or: [
			{ status: 'done', completedDate: { $gte: since } },
			{ status: { $in: ['wip', 'review'] }, wipDate: { $exists: true } }
		]
	})
		.select('_id trackingNumber title status tags wipDate completedDate itemType')
		.lean()) as any[];

	const pastSpans = past
		.filter((t) => t.wipDate)
		.map((t) => ({
			id: String(t._id),
			trackingNumber: t.trackingNumber ?? null,
			title: t.title,
			status: t.status,
			lane: (t.tags ?? [])[0] ?? 'untagged',
			start: new Date(t.wipDate).toISOString(),
			end: t.completedDate ? new Date(t.completedDate).toISOString() : null // null = still going
		}));

	return {
		roadmap: JSON.parse(JSON.stringify(roadmap)),
		pastSpans: JSON.parse(JSON.stringify(pastSpans)),
		user: JSON.parse(JSON.stringify(locals.user))
	};
};
