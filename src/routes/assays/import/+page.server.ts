import { fail, redirect } from '@sveltejs/kit';
import { connectDB, AssayDefinition } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import { generateLegacyAssayId } from '$lib/server/assay-legacy-shape';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:write');
	return {};
};

export const actions: Actions = {
	preview: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');

		const data = await request.formData();
		const file = data.get('file') as File;
		if (!file || !file.name) return fail(400, { error: 'No file provided' });

		const text = await file.text();
		let parsed: any;
		try {
			parsed = JSON.parse(text);
		} catch {
			return fail(400, { error: 'Invalid JSON file' });
		}

		// Support both single assay and array of assays
		const items: any[] = Array.isArray(parsed) ? parsed : [parsed];

		const previews = items.map((item, idx) => ({
			idx,
			name: item.name ?? 'Unnamed',
			skuCode: item.skuCode ?? null,
			description: item.description ?? null,
			reagentCount: (item.reagents ?? []).length
		}));

		return { previews, rawJson: text, importResult: null };
	},

	import: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();

		const data = await request.formData();
		const rawJson = data.get('rawJson')?.toString();
		const selectedIndices = data.getAll('selected').map((v) => parseInt(v.toString()));

		if (!rawJson) return fail(400, { error: 'No data to import' });

		let items: any[];
		try {
			const parsed = JSON.parse(rawJson);
			items = Array.isArray(parsed) ? parsed : [parsed];
		} catch {
			return fail(400, { error: 'Invalid JSON data' });
		}

		const toImport = selectedIndices.length > 0
			? items.filter((_, idx) => selectedIndices.includes(idx))
			: items;

		const created: string[] = [];
		for (const item of toImport) {
			// Preserve the imported doc's _id if it already matches the legacy
			// A######## format; otherwise mint a new legacy-format ID.
			const importedId = typeof item._id === 'string' ? item._id : undefined;
			const idLooksLegacy = importedId && /^A[0-9A-F]{7}$/.test(importedId);
			const _id = idLooksLegacy ? importedId! : await generateLegacyAssayId(AssayDefinition as any);

			const assay = await AssayDefinition.create({
				_id,
				name: item.name,
				// Legacy default is null; respect imported value if any.
				skuCode: item.skuCode ?? null,
				description: item.description,
				duration: item.duration,
				// Pass through legacy markers from the source file verbatim — imports
				// of a legacy export should round-trip exactly.
				BCODE: item.BCODE ?? undefined,
				hidden: item.hidden ?? true,
				protected: item.protected ?? true,
				isActive: true,
				reagents: item.reagents ?? [],
				versionHistory: []
			});
			created.push(assay._id);
		}

		return {
			importResult: { count: created.length, ids: created },
			previews: [],
			rawJson: ''
		};
	}
};

export const config = { maxDuration: 60 };
