import { error, redirect, fail } from '@sveltejs/kit';
import { connectDB, AssayDefinition } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:write');
	await connectDB();

	const assay = await AssayDefinition.findById(params.assayId).lean() as any;
	if (!assay) throw error(404, 'Assay not found');

	return {
		assay: {
			id: assay._id,
			name: assay.name,
			skuCode: assay.skuCode ?? null,
			description: assay.description ?? null,
			duration: assay.duration ?? null,
			shelfLifeDays: assay.shelfLifeDays ?? null,
			bomCostOverride: assay.bomCostOverride ?? null,
			useSingleCost: assay.useSingleCost ?? false,
			lockedAt: assay.lockedAt ?? null,
			reagents: assay.reagents ?? [],
			configuration: assay.metadata ?? {},
			createdAt: assay.createdAt,
			updatedAt: assay.updatedAt
		}
	};
};

export const actions: Actions = {
	default: async ({ request, params, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();

		const assay = await AssayDefinition.findById(params.assayId).lean() as any;
		if (!assay) throw error(404, 'Assay not found');

		// If locked, reject changes to reagent formula
		if (assay.lockedAt) {
			return fail(403, { error: 'Assay is locked. Reagent formula cannot be changed. Create a new version instead.' });
		}

		const data = await request.formData();
		const update: Record<string, any> = {};

		const name = data.get('name');
		if (name) update.name = name;
		const skuCode = data.get('skuCode');
		if (skuCode) update.skuCode = skuCode;
		const description = data.get('description');
		if (description !== null) update.description = description || undefined;
		const duration = data.get('duration');
		if (duration) update.duration = Number(duration);
		const shelfLifeDays = data.get('shelfLifeDays');
		if (shelfLifeDays) update.shelfLifeDays = Number(shelfLifeDays);

		// Push version history entry (append-only)
		const versionEntry = {
			version: (assay.versionHistory?.length ?? 0) + 1,
			previousName: assay.name,
			previousDescription: assay.description,
			previousDuration: assay.duration,
			changedBy: { _id: locals.user._id, username: locals.user.username },
			changedAt: new Date(),
			changeNotes: (data.get('changeNotes') as string) || undefined
		};

		await AssayDefinition.findByIdAndUpdate(params.assayId, {
			$set: update,
			$push: { versionHistory: versionEntry }
		});

		redirect(303, `/spu/assays/${params.assayId}`);
	}
};
