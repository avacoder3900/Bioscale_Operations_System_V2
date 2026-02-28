import { fail } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, PartDefinition, InventoryTransaction, generateId } from '$lib/server/db';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'inventory:read');
	await connectDB();

	const parts = await PartDefinition.find().sort({ sortOrder: 1, partNumber: 1 }).lean();

	return {
		parts: parts.map((p) => ({
			id: p._id,
			partNumber: p.partNumber ?? '',
			name: p.name ?? '',
			description: p.description ?? null,
			category: p.category ?? null,
			currentStock: 0, // computed from transactions if needed
			unit: p.unitOfMeasure ?? 'ea',
			reorderPoint: p.minimumOrderQty ?? null,
			isActive: p.isActive ?? true,
			createdAt: p.createdAt
		}))
	};
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		requirePermission(locals.user, 'inventory:write');
		await connectDB();
		const form = await request.formData();
		const partNumber = form.get('partNumber')?.toString().trim();
		const name = form.get('name')?.toString().trim();
		if (!partNumber || !name) return fail(400, { error: 'Part number and name are required' });

		const existing = await PartDefinition.findOne({ partNumber });
		if (existing) return fail(400, { error: 'Part number already exists' });

		await PartDefinition.create({
			_id: generateId(),
			partNumber,
			name,
			description: form.get('description')?.toString().trim() || undefined,
			category: form.get('category')?.toString().trim() || undefined,
			unitOfMeasure: form.get('unit')?.toString().trim() || 'ea',
			minimumOrderQty: form.get('reorderPoint') ? Number(form.get('reorderPoint')) : undefined,
			createdBy: locals.user!._id
		});
		return { success: true };
	}
};
