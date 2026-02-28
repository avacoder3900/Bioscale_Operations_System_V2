import { fail, error } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, BomItem, generateId } from '$lib/server/db';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	requirePermission(locals.user, 'inventory:read');
	await connectDB();

	const item = await BomItem.findById(params.bomId).lean();
	if (!item) throw error(404, 'BOM item not found');

	return {
		item: {
			id: (item as any)._id,
			partNumber: (item as any).partNumber ?? '',
			name: (item as any).name ?? '',
			description: (item as any).description ?? null,
			unitCost: (item as any).unitCost ? Number((item as any).unitCost) : null,
			quantity: (item as any).inventoryCount ?? null,
			supplier: (item as any).supplier ?? null,
			category: (item as any).category ?? null,
			isActive: (item as any).isActive ?? true,
			expirationDate: (item as any).expirationDate ?? null,
			folderId: null,
			bomType: (item as any).bomType ?? 'spu',
			quantityPerUnit: (item as any).quantityPerUnit ?? null,
			versionHistory: (item as any).versionHistory ?? [],
			partLinks: (item as any).partLinks ?? []
		}
	};
};

export const actions: Actions = {
	update: async ({ request, locals, params }) => {
		requirePermission(locals.user, 'inventory:write');
		await connectDB();
		const form = await request.formData();
		const existing = await BomItem.findById(params.bomId).lean();
		if (!existing) return fail(404, { error: 'BOM item not found' });

		const updates: Record<string, any> = {};
		for (const field of ['name', 'description', 'supplier', 'category', 'unitCost', 'partNumber']) {
			const val = form.get(field)?.toString().trim();
			if (val !== undefined && val !== null) updates[field] = val || undefined;
		}
		if (form.get('quantityPerUnit')) updates.quantityPerUnit = Number(form.get('quantityPerUnit'));
		if (form.get('isActive') !== null) updates.isActive = form.get('isActive') === 'true';

		// Push version history
		const versionEntry = {
			version: ((existing as any).versionHistory?.length ?? 0) + 1,
			changeType: 'update',
			previousValues: updates,
			changedBy: locals.user!._id,
			changedAt: new Date(),
			changeReason: form.get('changeReason')?.toString() || 'Updated'
		};

		await BomItem.updateOne({ _id: params.bomId }, {
			$set: updates,
			$push: { versionHistory: versionEntry }
		});
		return { success: true };
	},

	delete: async ({ locals, params }) => {
		requirePermission(locals.user, 'inventory:write');
		await connectDB();
		await BomItem.deleteOne({ _id: params.bomId });
		return { success: true };
	}
};
