import { connectDB, Document, User } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url }) => {
	await connectDB();
	const selectedCategory = url.searchParams.get('category');

	const filter: any = {};
	if (selectedCategory) filter.category = selectedCategory;

	const [docs, categories] = await Promise.all([
		Document.find(filter).sort({ createdAt: -1 }).lean(),
		Document.distinct('category')
	]);

	// Collect owner IDs to resolve usernames
	const ownerIds = [...new Set(docs.map((d: any) => d.ownerId).filter(Boolean))];
	const owners = ownerIds.length > 0
		? await User.find({ _id: { $in: ownerIds } }).select('_id username').lean()
		: [];
	const ownerMap = new Map(owners.map((u: any) => [u._id, u.username]));

	return {
		documents: docs.map((d: any) => ({
			id: d._id,
			documentNumber: d.documentNumber ?? '',
			title: d.title ?? '',
			category: d.category ?? null,
			currentRevision: parseInt(d.currentRevision) || 0,
			status: d.status ?? 'draft',
			effectiveDate: d.effectiveDate ?? null,
			ownerId: d.ownerId ?? null,
			ownerUsername: d.ownerId ? (ownerMap.get(d.ownerId) ?? null) : null,
			createdAt: d.createdAt
		})),
		categories: categories.filter(Boolean) as string[],
		selectedCategory
	};
};
