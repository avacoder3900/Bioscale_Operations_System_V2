import { fail, error } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, PartDefinition, InventoryTransaction, LotRecord, generateId } from '$lib/server/db';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	requirePermission(locals.user, 'inventory:read');
	await connectDB();

	const part = await PartDefinition.findById(params.partId).lean();
	if (!part) throw error(404, 'Part not found');

	const [lots, transactions] = await Promise.all([
		LotRecord.find({ partDefinitionId: params.partId }).sort({ receivedAt: -1 }).lean(),
		InventoryTransaction.find({ partDefinitionId: params.partId }).sort({ performedAt: -1 }).limit(100).lean()
	]);

	return {
		part: {
			id: part._id,
			partNumber: part.partNumber ?? '',
			name: part.name ?? '',
			description: part.description ?? null,
			category: part.category ?? null,
			currentStock: 0,
			unit: part.unitOfMeasure ?? 'ea',
			reorderPoint: part.minimumOrderQty ?? null,
			isActive: part.isActive ?? true,
			createdAt: part.createdAt,
			updatedAt: part.updatedAt
		},
		lots: lots.map((l: any) => ({
			id: l._id,
			lotNumber: l.lotNumber ?? '',
			quantity: l.quantity ?? 0,
			receivedAt: l.receivedAt ?? l.createdAt,
			expirationDate: l.expirationDate ?? null,
			status: l.status ?? 'active'
		})),
		transactions: transactions.map((t: any) => ({
			id: t._id,
			transactionType: t.transactionType,
			quantity: t.quantity,
			lotNumber: null,
			notes: t.reason ?? null,
			createdAt: t.performedAt ?? t.createdAt,
			createdByUsername: t.performedBy ?? ''
		}))
	};
};

export const actions: Actions = {
	update: async ({ request, locals, params }) => {
		requirePermission(locals.user, 'inventory:write');
		await connectDB();
		const form = await request.formData();
		const updates: Record<string, any> = {};
		for (const field of ['name', 'description', 'category', 'unitOfMeasure']) {
			const val = form.get(field)?.toString().trim();
			if (val !== undefined && val !== null) updates[field] = val || undefined;
		}
		const reorder = form.get('reorderPoint');
		if (reorder) updates.minimumOrderQty = Number(reorder);

		await PartDefinition.updateOne({ _id: params.partId }, { $set: updates });
		return { success: true };
	},

	receiveLot: async ({ request, locals, params }) => {
		requirePermission(locals.user, 'inventory:write');
		await connectDB();
		const form = await request.formData();
		const lotNumber = form.get('lotNumber')?.toString().trim();
		const quantity = Number(form.get('quantity'));
		if (!lotNumber || !quantity) return fail(400, { error: 'Lot number and quantity required' });

		await LotRecord.create({
			_id: generateId(),
			partDefinitionId: params.partId,
			lotNumber,
			quantity,
			expirationDate: form.get('expirationDate') ? new Date(form.get('expirationDate')!.toString()) : undefined,
			receivedAt: new Date(),
			status: 'active',
			createdBy: locals.user!._id
		});

		// Create receipt transaction
		await InventoryTransaction.create({
			_id: generateId(),
			partDefinitionId: params.partId,
			transactionType: 'receipt',
			quantity,
			reason: `Lot ${lotNumber} received`,
			performedBy: locals.user!.username,
			performedAt: new Date()
		});

		return { success: true };
	}
};
