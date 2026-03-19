import { fail, error } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, BomItem, PartDefinition, generateId } from '$lib/server/db';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	requirePermission(locals.user, 'inventory:read');
	await connectDB();

	const item = await BomItem.findById(params.bomId).lean();
	if (!item) throw error(404, 'BOM item not found');
	const it = item as any;

	// Look up linked part definition by part number
	const partDef = it.partNumber
		? await PartDefinition.findOne({ partNumber: it.partNumber }, {
				_id: 1, partNumber: 1, name: 1, supplier: 1, vendorPartNumber: 1,
				unitCost: 1, leadTimeDays: 1, minimumOrderQty: 1, hazardClass: 1, inventoryCount: 1
			}).lean()
		: null;

	// Extract version history from the item
	const versions = (it.versionHistory ?? []).map((v: any) => ({
		id: v._id ?? `${it._id}-v${v.version}`,
		version: v.version,
		changeType: v.changeType ?? 'update',
		changedAt: v.changedAt ?? null,
		changedBy: v.changedBy?.username ?? null,
		changeReason: v.changeReason ?? null,
		previousValues: v.previousValues ?? null
	}));

	return {
		item: {
			id: it._id,
			partNumber: it.partNumber ?? '',
			name: it.name ?? '',
			description: it.description ?? null,
			unitCost: it.unitCost?.toString() ?? null,
			inventoryCount: (partDef as any)?.inventoryCount ?? it.inventoryCount ?? 0,
			quantity: it.inventoryCount ?? null,
			supplier: it.supplier ?? null,
			category: it.category ?? null,
			isActive: it.isActive ?? true,
			expirationDate: it.expirationDate ?? null,
			folderId: null,
			bomType: it.bomType ?? 'spu',
			quantityPerUnit: it.quantityPerUnit ?? null,
			versionHistory: it.versionHistory ?? [],
			partLinks: it.partLinks ?? []
		},
		part: partDef ? {
			id: (partDef as any)._id,
			partNumber: (partDef as any).partNumber ?? '',
			name: (partDef as any).name ?? '',
			supplier: (partDef as any).supplier ?? null,
			vendorPartNumber: (partDef as any).vendorPartNumber ?? null,
			unitCost: (partDef as any).unitCost?.toString() ?? null,
			leadTimeDays: (partDef as any).leadTimeDays ?? null,
			minimumOrderQty: (partDef as any).minimumOrderQty ?? null,
			hazardClass: (partDef as any).hazardClass ?? null
		} : null,
		versions
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
		return { success: true, message: 'BOM item updated successfully' };
	},

	delete: async ({ locals, params }) => {
		requirePermission(locals.user, 'inventory:write');
		await connectDB();
		await BomItem.deleteOne({ _id: params.bomId });
		return { success: true, message: 'BOM item deleted' };
	}
};
