import { connectDB, Document, User } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	await connectDB();
	const userId = locals.user?._id;

	// Get all documents to find training records and pending training
	const docs = await Document.find({ status: { $in: ['approved', 'in_review'] } }).lean();

	const completedTraining: any[] = [];
	const pendingTraining: any[] = [];

	// Collect trainer IDs
	const trainerIds = new Set<string>();
	for (const doc of docs as any[]) {
		for (const rev of doc.revisions ?? []) {
			for (const tr of rev.trainingRecords ?? []) {
				if (tr.trainerId) trainerIds.add(tr.trainerId);
			}
		}
	}
	const trainers = trainerIds.size > 0
		? await User.find({ _id: { $in: [...trainerIds] } }).select('_id username').lean()
		: [];
	const trainerMap = new Map(trainers.map((u: any) => [u._id, u.username]));

	for (const doc of docs as any[]) {
		// Find the current approved revision
		const currentRev = (doc.revisions ?? []).find(
			(r: any) => r.status === 'approved' && r.revision === doc.currentRevision
		);

		// All user's training records across revisions
		for (const rev of doc.revisions ?? []) {
			for (const tr of rev.trainingRecords ?? []) {
				if (tr.userId === userId) {
					completedTraining.push({
						trainingId: tr._id,
						trainedAt: tr.trainedAt,
						notes: tr.notes ?? null,
						revisionId: rev._id,
						revision: parseInt(rev.revision) || 0,
						documentId: doc._id,
						documentNumber: doc.documentNumber ?? '',
						documentTitle: doc.title ?? '',
						documentCategory: doc.category ?? null,
						trainerUsername: tr.trainerId ? (trainerMap.get(tr.trainerId) ?? null) : null
					});
				}
			}
		}

		// Check if user needs training on current approved revision
		if (currentRev) {
			const hasTrained = (currentRev.trainingRecords ?? []).some(
				(tr: any) => tr.userId === userId
			);
			if (!hasTrained) {
				pendingTraining.push({
					documentId: doc._id,
					documentNumber: doc.documentNumber ?? '',
					title: doc.title ?? '',
					category: doc.category ?? null,
					currentRevision: parseInt(doc.currentRevision) || 0,
					status: doc.status,
					effectiveDate: doc.effectiveDate ?? null,
					revisionId: currentRev._id,
					revisionContent: currentRev.content ?? null,
					revisionChangeDescription: currentRev.changeDescription ?? null
				});
			}
		}
	}

	return { completedTraining, pendingTraining };
};
