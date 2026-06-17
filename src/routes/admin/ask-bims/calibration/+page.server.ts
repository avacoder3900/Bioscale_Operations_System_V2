import { redirect } from '@sveltejs/kit';
import { connectDB, AskBimsConversationLog, AskBimsFeedback } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad } from './$types';

/**
 * Confidence calibration analysis (Phase M.3, 2026-05-13).
 *
 * The agent stamps each answer with one of high / partial / degraded based on
 * tool-result conditions (inferConfidence in ask-bims.ts). Per the operator-
 * polish plan, the rule is well-calibrated only if:
 *   - high-confidence answers get thumbs-down <10% of the time
 *   - degraded-confidence answers correctly correlate with thumbs-down
 *
 * This page pulls the last N conversations (default 200), joins them to
 * thumbs feedback by responseId, and rolls up the cross-tab. If the
 * miscalibration threshold is tripped, it surfaces the sample failures so
 * the operator-polish stream can tune inferConfidence directly.
 *
 * No data is mutated. Read-only admin-only.
 */
export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'admin:full');
	await connectDB();

	const sampleSize = Math.min(Math.max(Number(url.searchParams.get('n') ?? 200), 50), 1000);
	const MISCAL_THRESHOLD_PCT = 10; // from the operator-polish plan

	// 1. Pull the most recent N conversations (any confidence).
	const convs = await AskBimsConversationLog.find({})
		.select('responseId timestamp model confidence confidenceReasons question answer toolCallCount')
		.sort({ timestamp: -1 })
		.limit(sampleSize)
		.lean() as any[];

	// 2. Pull all feedback joined by responseId.
	const respIds = convs.map(c => c.responseId).filter(Boolean);
	const fbs = respIds.length === 0
		? []
		: await AskBimsFeedback.find({ responseId: { $in: respIds } })
			.select('responseId rating comment flagged flagReason')
			.lean() as any[];

	const fbByResp = new Map<string, any[]>();
	for (const f of fbs) {
		const arr = fbByResp.get(f.responseId) ?? [];
		arr.push(f);
		fbByResp.set(f.responseId, arr);
	}

	// 3. Roll up — cross-tab of confidence × rating.
	type Bucket = 'high' | 'partial' | 'degraded' | 'unknown';
	const matrix: Record<Bucket, { total: number; up: number; down: number; flagged: number; unrated: number }> = {
		high:     { total: 0, up: 0, down: 0, flagged: 0, unrated: 0 },
		partial:  { total: 0, up: 0, down: 0, flagged: 0, unrated: 0 },
		degraded: { total: 0, up: 0, down: 0, flagged: 0, unrated: 0 },
		unknown:  { total: 0, up: 0, down: 0, flagged: 0, unrated: 0 }
	};

	const highWithDowns: Array<{
		responseId: string;
		timestamp: Date;
		question: string;
		answer: string;
		confidenceReasons: string[];
		comment?: string;
		toolCallCount: number;
	}> = [];

	for (const c of convs) {
		const bucket: Bucket = c.confidence === 'high' ? 'high'
			: c.confidence === 'partial' ? 'partial'
			: c.confidence === 'degraded' ? 'degraded'
			: 'unknown';
		matrix[bucket].total++;
		const feedbacks = fbByResp.get(c.responseId) ?? [];
		if (feedbacks.length === 0) {
			matrix[bucket].unrated++;
			continue;
		}
		let rated = false;
		for (const f of feedbacks) {
			if (f.rating === 'up') { matrix[bucket].up++; rated = true; }
			if (f.rating === 'down') {
				matrix[bucket].down++;
				rated = true;
				if (bucket === 'high') {
					highWithDowns.push({
						responseId: c.responseId,
						timestamp: c.timestamp,
						question: c.question,
						answer: c.answer,
						confidenceReasons: c.confidenceReasons ?? [],
						comment: f.comment,
						toolCallCount: c.toolCallCount ?? 0
					});
				}
			}
			if (f.flagged) matrix[bucket].flagged++;
		}
		if (!rated) matrix[bucket].unrated++;
	}

	// 4. Compute miscalibration verdict for the high bucket.
	const highRated = matrix.high.up + matrix.high.down;
	const highDownPct = highRated > 0 ? (matrix.high.down / highRated) * 100 : 0;
	const miscalibrated = highRated >= 10 && highDownPct > MISCAL_THRESHOLD_PCT;
	const insufficient = highRated < 10;

	// 5. Pattern hints — when there's enough data, which tools or
	//    confidenceReasons recur in the high+down set? These point at
	//    rules in inferConfidence that need a closer look.
	const reasonFreq = new Map<string, number>();
	for (const sample of highWithDowns) {
		for (const r of sample.confidenceReasons ?? []) {
			reasonFreq.set(r, (reasonFreq.get(r) ?? 0) + 1);
		}
	}
	const topReasonsOnFailures = Array.from(reasonFreq.entries())
		.sort((a, b) => b[1] - a[1])
		.slice(0, 10)
		.map(([reason, count]) => ({ reason, count }));

	return JSON.parse(JSON.stringify({
		sampleSize,
		analyzedCount: convs.length,
		matrix,
		highDownPct: Math.round(highDownPct * 10) / 10,
		threshold: MISCAL_THRESHOLD_PCT,
		miscalibrated,
		insufficient,
		highWithDowns: highWithDowns.slice(0, 25),
		topReasonsOnFailures,
		generatedAt: new Date().toISOString()
	}));
};

export const config = { maxDuration: 30 };
