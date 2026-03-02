import { requirePermission } from '$lib/server/permissions';
import { connectDB } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'inventory:read');
	await connectDB();

	// BOM folders are a UI concept — no separate collection in MongoDB
	// Return empty for now; can be extended with a folders collection if needed
	return {
		folders: [] as { id: string; name: string; itemCount: number }[]
	};
};
