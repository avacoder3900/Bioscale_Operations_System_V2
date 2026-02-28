import { error } from '@sveltejs/kit';
import { connectDB, Document, User } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals }) => {
	await connectDB();
	const doc = await Document.findById(params.id).lean() as any;
	if (!doc) error(404, 'Document not found');

	// Resolve owner username
	let ownerUsername: string | null = null;
	if (doc.ownerId) {
		const owner = await User.findById(doc.ownerId).select('username').lean() as any;
		ownerUsername = owner?.username ?? null;
	}

	// Resolve revision creator usernames
	const creatorIds = [...new Set((doc.revisions ?? []).map((r: any) => r.createdBy).filter(Boolean))];
	const creators = creatorIds.length > 0
		? await User.find({ _id: { $in: creatorIds } }).select('_id username').lean()
		: [];
	const creatorMap = new Map(creators.map((u: any) => [u._id, u.username]));

	// Get user's training records across all revisions
	const userId = locals.user?._id;
	const userTraining: any[] = [];
	for (const rev of doc.revisions ?? []) {
		for (const tr of rev.trainingRecords ?? []) {
			if (tr.userId === userId) {
				userTraining.push({
					id: tr._id,
					documentRevisionId: rev._id,
					trainedAt: tr.trainedAt,
					revision: parseInt(rev.revision) || 0
				});
			}
		}
	}

	return {
		document: {
			id: doc._id,
			documentNumber: doc.documentNumber ?? '',
			title: doc.title ?? '',
			category: doc.category ?? null,
			currentRevision: parseInt(doc.currentRevision) || 0,
			status: doc.status ?? 'draft',
			effectiveDate: doc.effectiveDate ?? null,
			retiredDate: doc.retiredDate ?? null,
			ownerId: doc.ownerId ?? null,
			ownerUsername,
			createdAt: doc.createdAt,
			updatedAt: doc.updatedAt
		},
		revisions: (doc.revisions ?? []).map((r: any) => ({
			id: r._id,
			revision: parseInt(r.revision) || 0,
			content: r.content ?? null,
			changeDescription: r.changeDescription ?? null,
			status: r.status ?? 'draft',
			createdAt: r.createdAt,
			createdBy: r.createdBy ? (creatorMap.get(r.createdBy) ?? null) : null,
			approvedAt: r.approvedAt ?? null
		})),
		userTraining
	};
};
