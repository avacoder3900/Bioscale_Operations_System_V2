import { fail } from '@sveltejs/kit';
import { hasPermission, requirePermission } from '$lib/server/permissions';
import { connectDB, InventoryTransaction, PartDefinition, User, generateId } from '$lib/server/db';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	requirePermission(locals.user, 'inventory:read');
	await connectDB();

	// Parse filter params from URL
	const partId = url.searchParams.get('partId') || null;
	const type = url.searchParams.get('type') || null;
	const startDate = url.searchParams.get('startDate') || null;
	const endDate = url.searchParams.get('endDate') || null;
	const retracted = url.searchParams.get('retracted') || null;

	// Build query from filters
	const query: any = {};
	if (partId) query.partDefinitionId = partId;
	if (type) query.transactionType = type;
	if (startDate || endDate) {
		query.performedAt = {};
		if (startDate) query.performedAt.$gte = new Date(startDate);
		if (endDate) query.performedAt.$lte = new Date(endDate + 'T23:59:59.999Z');
	}
	if (retracted === 'yes') query.retractedAt = { $exists: true, $ne: null };
	if (retracted === 'no') query.$or = [{ retractedAt: { $exists: false } }, { retractedAt: null }];

	const [transactions, parts] = await Promise.all([
		InventoryTransaction.find(query).sort({ performedAt: -1 }).limit(200).lean(),
		PartDefinition.find({ isActive: true }).sort({ partNumber: 1 }).lean()
	]);

	// Build lookups
	const partMap = new Map(parts.map((p: any) => [p._id, p]));
	const performerNames = [...new Set(transactions.map((t: any) => t.performedBy).filter(Boolean))];
	const performers = performerNames.length > 0
		? await User.find({ username: { $in: performerNames } }).select('_id username').lean()
		: [];
	const performerMap = new Map(performers.map((u: any) => [u.username, u.username]));

	return {
		transactions: transactions.map((t: any) => {
			const part = partMap.get(t.partDefinitionId);
			return {
				id: t._id,
				partDefinitionId: t.partDefinitionId ?? '',
				partNumber: (part as any)?.partNumber ?? t.bomItemId ?? '',
				partName: (part as any)?.name ?? '',
				transactionType: t.transactionType,
				quantity: t.quantity,
				previousQuantity: t.previousQuantity ?? 0,
				newQuantity: t.newQuantity ?? 0,
				reason: t.reason ?? null,
				performedBy: t.performedBy ?? '',
				performedByName: performerMap.get(t.performedBy) ?? t.performedBy ?? null,
				performedAt: t.performedAt ?? null,
				assemblySessionId: t.assemblySessionId ?? null,
				retractedAt: t.retractedAt ?? null,
				retractedBy: t.retractedBy ?? null,
				retractionReason: t.retractionReason ?? null,
				isRetracted: Boolean(t.retractedAt)
			};
		}),
		parts: parts.map((p: any) => ({
			id: p._id,
			partNumber: p.partNumber ?? '',
			name: p.name ?? ''
		})),
		canRetract: hasPermission(locals.user, 'inventory:write'),
		filters: { partId, type, startDate, endDate, retracted }
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
