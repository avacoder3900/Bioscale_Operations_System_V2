import { redirect } from '@sveltejs/kit';
import { connectDB, AskBimsFeedback } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad } from './$types';

/**
 * Admin triage view for Ask BIMS thumbs feedback. Surfaces recent ratings —
 * thumbs-downs first since those are where the prompt/tool tuning levers
 * live, then a fuller all-ratings feed for context.
 *
 * The +page.svelte that renders this is a follow-up (UI-layer change). Until
 * that lands, this loader still works against a direct API consumer or a
 * future widget.
 */
export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'admin:full');
	await connectDB();

	const now = Date.now();
	const start7d = new Date(now - 7 * 86400e3);
	const start30d = new Date(now - 30 * 86400e3);

	const [
		recentDownsRaw,
		recentAllRaw,
		totalsLast30d,
		dailyLast7d,
		topToolsWithDowns
	] = await Promise.all([
		// Newest 50 thumbs-down ratings — the triage queue
		AskBimsFeedback.find({ rating: 'down' })
			.sort({ timestamp: -1 })
			.limit(50)
			.lean(),
		// Newest 50 ratings overall — for context
		AskBimsFeedback.find({})
			.sort({ timestamp: -1 })
			.limit(50)
			.lean(),
		// 30-day rollups
		AskBimsFeedback.aggregate([
			{ $match: { timestamp: { $gte: start30d } } },
			{ $group: { _id: '$rating', count: { $sum: 1 } } }
		]),
		// 7-day daily breakdown for a trend strip
		AskBimsFeedback.aggregate([
			{ $match: { timestamp: { $gte: start7d } } },
			{ $group: {
				_id: {
					day: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } },
					rating: '$rating'
				},
				count: { $sum: 1 }
			} },
			{ $sort: { '_id.day': 1 } }
		]),
		// Tools that show up most often on thumbs-down answers
		AskBimsFeedback.aggregate([
			{ $match: { rating: 'down', timestamp: { $gte: start30d } } },
			{ $unwind: { path: '$toolsUsed', preserveNullAndEmptyArrays: false } },
			{ $group: { _id: '$toolsUsed', downs: { $sum: 1 } } },
			{ $sort: { downs: -1 } },
			{ $limit: 10 }
		])
	]) as [any[], any[], any[], any[], any[]];

	const totals: Record<string, number> = { up: 0, down: 0 };
	for (const r of totalsLast30d) totals[r._id] = r.count;
	const totalRated = (totals.up ?? 0) + (totals.down ?? 0);

	function shape(r: any) {
		return {
			_id: r._id,
			timestamp: r.timestamp,
			username: r.username,
			responseId: r.responseId,
			question: r.question,
			answer: r.answer,
			toolsUsed: r.toolsUsed ?? [],
			model: r.model,
			confidence: r.confidence,
			rating: r.rating,
			comment: r.comment
		};
	}

	return JSON.parse(JSON.stringify({
		recentDowns: recentDownsRaw.map(shape),
		recentAll: recentAllRaw.map(shape),
		summary30d: {
			totalRated,
			upCount: totals.up ?? 0,
			downCount: totals.down ?? 0,
			downPct: totalRated > 0 ? Math.round((totals.down ?? 0) / totalRated * 1000) / 10 : 0
		},
		dailyLast7d: dailyLast7d.map(d => ({
			date: d._id.day,
			rating: d._id.rating,
			count: d.count
		})),
		topToolsOnDowns: topToolsWithDowns.map(t => ({ tool: t._id, downs: t.downs }))
	}));
};

export const config = { maxDuration: 30 };
