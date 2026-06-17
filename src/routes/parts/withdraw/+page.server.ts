import { fail } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, PartDefinition, InventoryTransaction, AuditLog, generateId } from '$lib/server/db';
import { recordTransaction } from '$lib/server/services/inventory-transaction';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'inventory:read');
	await connectDB();

	// Get all parts that have transaction history (scanned inventory)
	const txAgg = await InventoryTransaction.aggregate([
		{ $group: { _id: '$partDefinitionId', txCount: { $sum: 1 } } }
	]);
	const partIdsWithTx = txAgg.map((t: any) => t._id).filter(Boolean);

	const parts = await PartDefinition.find({ _id: { $in: partIdsWithTx } })
		.select('_id partNumber name category inventoryCount barcode')
		.sort({ partNumber: 1 })
		.lean();

	return {
		parts: JSON.parse(JSON.stringify(parts))
	};
};

export const actions: Actions = {
	withdraw: async ({ request, locals }) => {
		requirePermission(locals.user, 'inventory:write');
		await connectDB();

		const form = await request.formData();
		const partId = form.get('partId')?.toString().trim();
		const qtyStr = form.get('quantity')?.toString().trim();
		const reason = form.get('reason')?.toString().trim();

		if (!partId) return fail(400, { error: 'Select a part' });
		if (!qtyStr || isNaN(Number(qtyStr)) || Number(qtyStr) <= 0) {
			return fail(400, { error: 'Enter a valid quantity greater than 0' });
		}
		if (!reason) return fail(400, { error: 'Provide a reason' });

		const quantity = Number(qtyStr);

		const part = await PartDefinition.findById(partId).lean() as any;
		if (!part) return fail(404, { error: 'Part not found' });

		const txId = await recordTransaction({
			transactionType: 'consumption',
			partDefinitionId: partId,
			quantity,
			operatorId: locals.user!._id,
			operatorUsername: locals.user!.username,
			notes: `Withdraw: ${reason}`
		});

		await AuditLog.create({
			_id: generateId(),
			tableName: 'inventory_transactions',
			recordId: txId,
			action: 'INSERT',
			newData: {
				transactionType: 'consumption',
				partNumber: part.partNumber,
				partName: part.name,
				quantity,
				reason
			},
			changedAt: new Date(),
			changedBy: locals.user!.username
		});

		const updatedPart = await PartDefinition.findById(partId).select('inventoryCount').lean() as any;

		return {
			success: true,
			message: `Withdrew ${quantity} of ${part.partNumber} — ${part.name}. New stock: ${updatedPart?.inventoryCount ?? '?'}`
		};
	}
};
