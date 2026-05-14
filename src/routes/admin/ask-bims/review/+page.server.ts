import { fail, redirect } from '@sveltejs/kit';
import { connectDB, AskBimsFeedback, AskBimsConversationLog } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import type { Actions, PageServerLoad } from './$types';

/**
 * Admin review queue for Ask BIMS — surfaces conversations operators have
 * explicitly flagged ("track this") OR thumbs-downed ("no this isn't right").
 * Built so a future Claude (or admin) can sweep these, identify patterns, and
 * apply tool-description / system-prompt fixes — the same workflow that
 * produced rule 9 (the wax-routing fix on 2026-05-13).
 *
 * Joined to AskBimsConversationLog by responseId when available, so the full
 * tool-call trail and previews land on the page alongside the flag reason.
 *
 * Filter knobs (?query):
 *   - status=open|reviewed|all (default: open)
 *   - kind=flagged|thumbs-down|both (default: both)
 *   - sinceDays=N (default: 30)
 *   - userId=<id>
 *
 * The +page.svelte that renders this is a follow-up — admin pages have been
 * mutated before (feedback, cost) but staying server-only here keeps this
 * change small and lets the future UI cherry-pick exactly the fields it wants.
 */

const PAGE_SIZE = 100;

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'admin:full');
	await connectDB();

	const status = (url.searchParams.get('status') ?? 'open').toLowerCase();
	const kind = (url.searchParams.get('kind') ?? 'both').toLowerCase();
	const sinceDays = Math.min(Math.max(Number(url.searchParams.get('sinceDays') ?? 30), 1), 365);
	const userIdFilter = url.searchParams.get('userId')?.trim() || null;
	const since = new Date(Date.now() - sinceDays * 86400e3);

	const filter: any = { timestamp: { $gte: since } };
	if (userIdFilter) filter.userId = userIdFilter;

	// Kind: flagged-only | thumbs-down-only | both
	if (kind === 'flagged') filter.flagged = true;
	else if (kind === 'thumbs-down') filter.rating = 'down';
	else filter.$or = [{ flagged: true }, { rating: 'down' }];

	// Status: open (unreviewed) | reviewed | all
	if (status === 'open') filter.reviewedAt = null;
	else if (status === 'reviewed') filter.reviewedAt = { $ne: null };
	// status='all' → no filter

	const rowsRaw = await AskBimsFeedback.find(filter)
		.sort({ timestamp: -1 })
		.limit(PAGE_SIZE + 1)
		.lean() as any[];
	const truncated = rowsRaw.length > PAGE_SIZE;
	const rows = rowsRaw.slice(0, PAGE_SIZE);

	// Join with conversation log by responseId for the full tool trail
	const responseIds = rows.map(r => r.responseId).filter(Boolean);
	const convoLogs = responseIds.length > 0
		? await AskBimsConversationLog.find({ responseId: { $in: responseIds } })
			.select('responseId toolCalls model costUsd durationMs errorClass')
			.lean() as any[]
		: [];
	const convoByResponseId = new Map(convoLogs.map(c => [c.responseId, c]));

	const items = rows.map(r => {
		const convo = convoByResponseId.get(r.responseId);
		return {
			_id: r._id,
			responseId: r.responseId,
			timestamp: r.timestamp,
			userId: r.userId,
			username: r.username,
			question: r.question,
			answer: r.answer,
			toolsUsed: r.toolsUsed,
			model: r.model,
			confidence: r.confidence,
			rating: r.rating,
			comment: r.comment,
			flagged: r.flagged,
			flagReason: r.flagReason,
			reviewedAt: r.reviewedAt,
			reviewedBy: r.reviewedBy,
			// Tool trail with previews from the conversation log (when present)
			toolCallTrail: convo?.toolCalls ?? null,
			conversationCostUsd: convo?.costUsd ?? null,
			conversationDurationMs: convo?.durationMs ?? null,
			conversationErrorClass: convo?.errorClass ?? null
		};
	});

	// Summary roll-up for the page header
	const [openFlaggedCount, openThumbsDownCount, totalLast30dRaw] = await Promise.all([
		AskBimsFeedback.countDocuments({ flagged: true, reviewedAt: null }),
		AskBimsFeedback.countDocuments({ rating: 'down', reviewedAt: null }),
		AskBimsFeedback.aggregate([
			{ $match: { timestamp: { $gte: new Date(Date.now() - 30 * 86400e3) } } },
			{ $group: {
				_id: null,
				flagged: { $sum: { $cond: ['$flagged', 1, 0] } },
				thumbsUp: { $sum: { $cond: [{ $eq: ['$rating', 'up'] }, 1, 0] } },
				thumbsDown: { $sum: { $cond: [{ $eq: ['$rating', 'down'] }, 1, 0] } }
			} }
		])
	]);
	const totalLast30d = (totalLast30dRaw as any[])[0] ?? { flagged: 0, thumbsUp: 0, thumbsDown: 0 };

	return {
		filter: { status, kind, sinceDays, userId: userIdFilter },
		summary: {
			openFlagged: openFlaggedCount,
			openThumbsDown: openThumbsDownCount,
			last30dFlagged: totalLast30d.flagged,
			last30dThumbsUp: totalLast30d.thumbsUp,
			last30dThumbsDown: totalLast30d.thumbsDown
		},
		items: JSON.parse(JSON.stringify(items)),
		truncated,
		pageSize: PAGE_SIZE
	};
};

/**
 * Form actions for the review queue.
 *
 * markReviewed: stamp reviewedAt + reviewedBy on a feedback row. Removes it
 *   from the default open-queue view. Idempotent.
 *
 * unReview: clear the review stamps. Useful if an item was prematurely
 *   marked or needs another look.
 *
 * Both are admin:full — same gate as the page load.
 */
export const actions: Actions = {
	markReviewed: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'admin:full');
		await connectDB();
		const data = await request.formData();
		const feedbackId = data.get('feedbackId')?.toString().trim();
		if (!feedbackId) return fail(400, { error: 'feedbackId required' });
		const row = await AskBimsFeedback.findByIdAndUpdate(
			feedbackId,
			{
				$set: {
					reviewedAt: new Date(),
					reviewedBy: locals.user.username ?? locals.user._id
				}
			},
			{ new: true }
		).lean();
		if (!row) return fail(404, { error: 'Feedback row not found' });
		return { success: true, feedbackId };
	},
	unReview: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'admin:full');
		await connectDB();
		const data = await request.formData();
		const feedbackId = data.get('feedbackId')?.toString().trim();
		if (!feedbackId) return fail(400, { error: 'feedbackId required' });
		const row = await AskBimsFeedback.findByIdAndUpdate(
			feedbackId,
			{ $set: { reviewedAt: null, reviewedBy: null } },
			{ new: true }
		).lean();
		if (!row) return fail(404, { error: 'Feedback row not found' });
		return { success: true, feedbackId };
	}
};
