import { requirePermission } from '$lib/server/permissions';
import { connectDB, Document, User } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'document:approve');
	await connectDB();

	// Aggregate to find all revisions with status 'in_review'
	const results = await Document.aggregate([
		{ $unwind: '$revisions' },
		{ $match: { 'revisions.status': 'in_review' } },
		{ $project: {
			documentNumber: 1, title: 1, category: 1,
			'revisions._id': 1, 'revisions.revision': 1,
			'revisions.changeDescription': 1, 'revisions.createdAt': 1,
			'revisions.createdBy': 1
		}}
	]);

	// Resolve submitter usernames
	const submitterIds = [...new Set(results.map((r: any) => r.revisions.createdBy).filter(Boolean))];
	const submitters = submitterIds.length > 0
		? await User.find({ _id: { $in: submitterIds } }).select('_id username').lean()
		: [];
	const submitterMap = new Map(submitters.map((u: any) => [u._id, u.username]));

	return {
		pendingRevisions: results.map((r: any) => ({
			revisionId: r.revisions._id,
			revision: parseInt(r.revisions.revision) || 0,
			changeDescription: r.revisions.changeDescription ?? null,
			submittedAt: r.revisions.createdAt,
			submittedById: r.revisions.createdBy ?? null,
			submittedByUsername: r.revisions.createdBy ? (submitterMap.get(r.revisions.createdBy) ?? null) : null,
			documentId: r._id,
			documentNumber: r.documentNumber ?? '',
			title: r.title ?? '',
			category: r.category ?? null
		}))
	};
};
