import { redirect } from '@sveltejs/kit';
import { connectDB, AssayDefinition } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:write');
	return {};
};

export const actions: Actions = {
	default: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();

		const data = await request.formData();
		const assay = await AssayDefinition.create({
			name: data.get('name') as string,
			skuCode: data.get('skuCode') as string,
			description: (data.get('description') as string) || undefined,
			duration: data.get('duration') ? Number(data.get('duration')) : undefined,
			shelfLifeDays: data.get('shelfLifeDays') ? Number(data.get('shelfLifeDays')) : undefined,
			isActive: true,
			reagents: [],
			versionHistory: []
		});

		redirect(303, `/spu/assays/${assay._id}`);
	}
};
