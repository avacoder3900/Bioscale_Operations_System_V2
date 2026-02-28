import { fail } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, InventoryTransaction, PartDefinition, generateId } from '$lib/server/db';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'inventory:read');
	await connectDB();

	const [transactions, parts] = await Promise.all([
		InventoryTransaction.find().sort({ performedAt: -1 }).limit(200).lean(),
		PartDefinition.find({ isActive: true }).sort({ partNumber: 1 }).lean()
	]);

	// Build part lookup
	const partMap = new Map(parts.map((p: any) => [p._id, p]));

	return {
		transactions: transactions.map((t: any) => {
			const part = partMap.get(t.partDefinitionId);
			return {
				id: t._id,
				partId: t.partDefinitionId ?? '',
				partNumber: (part as any)?.partNumber ?? t.bomItemId ?? '',
				partName: (part as any)?.name ?? '',
				transactionType: t.transactionType,
				quantity: t.quantity,
				lotNumber: null,
				notes: t.reason ?? null,
				createdAt: t.performedAt,
				createdByUsername: t.performedBy ?? '',
				isRetracted: Boolean(t.retractedAt)
			};
		}),
		parts: parts.map((p: any) => ({
			id: p._id,
			partNumber: p.partNumber ?? '',
			name: p.name ?? ''
		}))
	};
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		requirePermission(locals.user, 'inventory:write');
		await connectDB();
		const form = await request.formData();
		const partId = form.get('partId')?.toString();
		const transactionType = form.get('transactionType')?.toString();
		const quantity = Number(form.get('quantity'));

		if (!partId || !transactionType || !quantity) {
			return fail(400, { error: 'Part, type, and quantity are required' });
		}

		await InventoryTransaction.create({
			_id: generateId(),
			partDefinitionId: partId,
			transactionType,
			quantity,
			reason: form.get('notes')?.toString() || undefined,
			performedBy: locals.user!.username,
			performedAt: new Date()
		});
		return { success: true };
	},

	retract: async ({ request, locals }) => {
		requirePermission(locals.user, 'inventory:write');
		await connectDB();
		const form = await request.formData();
		const transactionId = form.get('transactionId')?.toString();
		const reason = form.get('reason')?.toString();
		if (!transactionId || !reason) return fail(400, { error: 'Transaction ID and reason required' });

		const original = await InventoryTransaction.findById(transactionId).lean();
		if (!original) return fail(404, { error: 'Transaction not found' });

		// Create retraction transaction (immutable — we don't modify original)
		await InventoryTransaction.create({
			_id: generateId(),
			partDefinitionId: (original as any).partDefinitionId,
			bomItemId: (original as any).bomItemId,
			transactionType: 'retraction',
			quantity: -(original as any).quantity,
			reason: `Retraction of ${transactionId}: ${reason}`,
			performedBy: locals.user!.username,
			performedAt: new Date()
		});
		return { success: true };
	}
};
