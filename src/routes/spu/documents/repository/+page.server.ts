import { connectDB, DocumentRepository, User } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	requirePermission(locals.user, 'documentRepo:read');
	await connectDB();

	const pageSize = 50;
	const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1') || 1);

	const [docs, totalCount] = await Promise.all([
		DocumentRepository.find().sort({ uploadedAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
		DocumentRepository.countDocuments()
	]);

	const uploaderIds = [...new Set(docs.map((d: any) => d.uploadedBy).filter(Boolean))];
	const uploaders = uploaderIds.length > 0
		? await User.find({ _id: { $in: uploaderIds } }).select('_id username').lean()
		: [];
	const uploaderMap = new Map(uploaders.map((u: any) => [u._id, u.username]));

	return {
		documents: docs.map((d: any) => ({
			id: d._id,
			title: d.description ?? d.originalFileName ?? d.fileName ?? '',
			fileName: d.originalFileName ?? d.fileName ?? '',
			fileType: d.mimeType ?? 'application/octet-stream',
			fileSize: d.fileSize ?? 0,
			category: d.category ?? null,
			uploadedAt: d.uploadedAt ?? d.createdAt ?? new Date(),
			uploadedByUsername: d.uploadedBy ? (uploaderMap.get(d.uploadedBy) ?? 'Unknown') : 'Unknown',
			url: `/api/files/${d._id}`
		})),
		page,
		pageSize,
		totalCount
	};
};
