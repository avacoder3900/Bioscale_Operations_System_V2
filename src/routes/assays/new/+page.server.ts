import { fail, redirect } from '@sveltejs/kit';
import { connectDB, AssayDefinition } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import { generateLegacyAssayId, toLegacyBcode } from '$lib/server/assay-legacy-shape';
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
		const name = (data.get('name') as string)?.trim();
		if (!name) return fail(400, { error: 'Assay name is required' });

		// Legacy shape: skuCode is typically null. Only set it when the operator
		// explicitly provides a value (we don't auto-generate like we used to).
		const skuCodeRaw = (data.get('skuCode') as string)?.trim();
		const skuCode = skuCodeRaw ? skuCodeRaw : null;

		// Parse instructions coming from the BcodeEditor (UI shape).
		let uiInstructions: any[] = [];
		const instructionsRaw = data.get('instructions') as string;
		if (instructionsRaw) {
			try {
				uiInstructions = JSON.parse(instructionsRaw);
			} catch {
				return fail(400, { error: 'Invalid instructions format' });
			}
		}

		const BCODE = toLegacyBcode(uiInstructions);
		const _id = await generateLegacyAssayId(AssayDefinition as any);

		const description = (data.get('description') as string) || undefined;
		const duration = data.get('duration') ? Number(data.get('duration')) : undefined;

		await AssayDefinition.create({
			_id,
			name,
			skuCode,
			description,
			duration,
			BCODE,
			hidden: true,
			protected: true,
			isActive: true,
			reagents: [],
			versionHistory: []
		});

		redirect(303, `/assays/${_id}`);
	}
};

export const config = { maxDuration: 60 };
