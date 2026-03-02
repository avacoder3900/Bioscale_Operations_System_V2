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
		const file = data.get('file') as File;
		if (!file) return { error: 'No file provided' };

		const text = await file.text();
		let parsed: any;
		try {
			parsed = JSON.parse(text);
		} catch {
			return { error: 'Invalid JSON file' };
		}

		const assay = await AssayDefinition.create({
			name: parsed.name,
			skuCode: parsed.skuCode,
			description: parsed.description,
			duration: parsed.duration,
			shelfLifeDays: parsed.shelfLifeDays,
			bcode: parsed.bcode ? (globalThis as any).Buffer.from(parsed.bcode, 'base64') : undefined,
			bcodeLength: parsed.bcodeLength,
			checksum: parsed.checksum,
			isActive: true,
			reagents: parsed.reagents ?? [],
			versionHistory: []
		});

		redirect(303, `/spu/assays/${assay._id}`);
	}
};
