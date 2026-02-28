import { redirect } from '@sveltejs/kit';
import { connectDB, AssayDefinition } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	await connectDB();

	const assays = await AssayDefinition.find().sort({ name: 1 }).lean();

	return {
		assays: assays.map((a: any) => ({
			id: a._id,
			name: a.name,
			skuCode: a.skuCode ?? null,
			version: a.versionHistory?.length ?? 0,
			status: a.lockedAt ? 'locked' : (a.isActive ? 'active' : 'inactive'),
			description: a.description ?? null,
			createdAt: a.createdAt,
			updatedAt: a.updatedAt
		}))
	};
};
