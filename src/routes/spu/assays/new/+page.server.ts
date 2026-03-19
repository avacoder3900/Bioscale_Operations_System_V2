import { fail, redirect } from '@sveltejs/kit';
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
		const name = data.get('name') as string;
		if (!name?.trim()) return fail(400, { error: 'Assay name is required' });

		// Auto-generate skuCode if not provided
		const skuCode = (data.get('skuCode') as string)?.trim() || `ASSAY-${Date.now().toString(36).toUpperCase()}`;

		// Parse instructions from the hidden field
		let instructions: any[] = [];
		const instructionsRaw = data.get('instructions') as string;
		if (instructionsRaw) {
			try {
				instructions = JSON.parse(instructionsRaw);
			} catch {
				return fail(400, { error: 'Invalid instructions format' });
			}
		}

		const assay = await AssayDefinition.create({
			name,
			skuCode,
			description: (data.get('description') as string) || undefined,
			duration: data.get('duration') ? Number(data.get('duration')) : undefined,
			shelfLifeDays: data.get('shelfLifeDays') ? Number(data.get('shelfLifeDays')) : undefined,
			isActive: true,
			metadata: { instructions },
			reagents: [],
			versionHistory: []
		});

		redirect(303, `/spu/assays/${assay._id}`);
	}
};
