import { json } from '@sveltejs/kit';
import { connectDB, PartDefinition, InventoryTransaction } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, params, url }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	await connectDB();

	const part = await PartDefinition.findById(params.partId).lean() as any;
	if (!part) return json({ error: 'Part not found' }, { status: 404 });

	// Build filter
	const filter: Record<string, any> = { partDefinitionId: params.partId };
	const typeFilter = url.searchParams.get('type');
	const startDate = url.searchParams.get('startDate');
	const endDate = url.searchParams.get('endDate');
	const operatorFilter = url.searchParams.get('operator');

	if (typeFilter) filter.transactionType = typeFilter;
	if (startDate || endDate) {
		filter.performedAt = {};
		if (startDate) filter.performedAt.$gte = new Date(startDate);
		if (endDate) filter.performedAt.$lte = new Date(endDate);
	}
	if (operatorFilter) {
		filter.$or = [
			{ operatorId: operatorFilter },
			{ operatorUsername: operatorFilter },
			{ performedBy: operatorFilter }
		];
	}

	const transactions = await InventoryTransaction.find(filter)
		.sort({ performedAt: -1 })
		.limit(500)
		.lean();

	const all = transactions as any[];
	const nonRetracted = all.filter((t: any) => !t.retractedAt);

	return json({
		success: true,
		part: {
			_id: part._id,
			partNumber: part.partNumber,
			name: part.name,
			inventoryCount: part.inventoryCount ?? 0
		},
		transactions: JSON.parse(JSON.stringify(all.map((t: any) => ({
			id: t._id,
			transactionType: t.transactionType,
			quantity: t.quantity,
			previousQuantity: t.previousQuantity,
			newQuantity: t.newQuantity,
			operatorUsername: t.operatorUsername ?? t.performedBy,
			performedAt: t.performedAt,
			lotId: t.lotId,
			cartridgeRecordId: t.cartridgeRecordId,
			manufacturingStep: t.manufacturingStep,
			manufacturingRunId: t.manufacturingRunId,
			notes: t.notes ?? t.reason,
			retractedAt: t.retractedAt,
			retractionReason: t.retractionReason
		})))),
		summary: {
			totalReceived: nonRetracted.filter((t: any) => t.transactionType === 'receipt').reduce((s: number, t: any) => s + Math.abs(t.quantity ?? 0), 0),
			totalConsumed: nonRetracted.filter((t: any) => t.transactionType === 'consumption' || t.transactionType === 'deduction').reduce((s: number, t: any) => s + Math.abs(t.quantity ?? 0), 0),
			totalCreated: nonRetracted.filter((t: any) => t.transactionType === 'creation').reduce((s: number, t: any) => s + Math.abs(t.quantity ?? 0), 0),
			totalScrapped: nonRetracted.filter((t: any) => t.transactionType === 'scrap').reduce((s: number, t: any) => s + Math.abs(t.quantity ?? 0), 0),
			currentCount: part.inventoryCount ?? 0,
			transactionCount: all.length
		}
	});
};
