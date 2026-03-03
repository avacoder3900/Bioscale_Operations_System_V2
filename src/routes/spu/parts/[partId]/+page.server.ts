import { fail, error } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, PartDefinition, InventoryTransaction, LotRecord, generateId } from '$lib/server/db';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params, url }) => {
	requirePermission(locals.user, 'inventory:read');
	await connectDB();

	const part = await PartDefinition.findById(params.partId).lean();
	if (!part) throw error(404, 'Part not found');
	const p = part as any;

	// URL filters
	const typeFilter = url.searchParams.get('type') ?? '';
	const startDate = url.searchParams.get('startDate') ?? '';
	const endDate = url.searchParams.get('endDate') ?? '';
	const retractedFilter = url.searchParams.get('retracted') ?? '';

	// Build transaction filter
	const txFilter: Record<string, any> = { partDefinitionId: params.partId };
	if (typeFilter) txFilter.transactionType = typeFilter;
	if (startDate || endDate) {
		txFilter.performedAt = {};
		if (startDate) txFilter.performedAt.$gte = new Date(startDate);
		if (endDate) txFilter.performedAt.$lte = new Date(endDate);
	}
	if (retractedFilter === 'true') txFilter.retractedAt = { $exists: true, $ne: null };
	if (retractedFilter === 'false') txFilter.retractedAt = { $exists: false };

	const [lots, transactions] = await Promise.all([
		LotRecord.find({ partDefinitionId: params.partId }).sort({ createdAt: -1 }).lean(),
		InventoryTransaction.find(txFilter).sort({ performedAt: -1 }).limit(200).lean()
	]);

	// Build versions from lot records as version entries
	const versions = (lots as any[]).map((l: any, idx: number) => ({
		id: l._id,
		version: idx + 1,
		versionNumber: idx + 1,
		lotNumber: l.lotNumber ?? '',
		quantity: l.quantityProduced ?? l.desiredQuantity ?? 0,
		status: l.status ?? 'completed',
		createdAt: l.createdAt ?? l.startTime,
		operatorName: l.operator?.username ?? null
	}));

	// Audit entries from lot step entries
	const auditEntries = (lots as any[]).flatMap((l: any) =>
		(l.stepEntries ?? []).map((step: any, i: number) => ({
			id: step._id ?? `${l._id}-step-${i}`,
			action: 'UPDATE',
			username: step.operator?.username ?? null,
			fieldPath: step.stepTitle ?? 'Step',
			previousValue: null,
			newValue: step.note ?? null,
			changedAt: step.completedAt ?? l.createdAt
		}))
	);

	return {
		item: {
			id: p._id,
			partNumber: p.partNumber ?? '',
			name: p.name ?? '',
			description: p.description ?? null,
			category: p.category ?? null,
			inventoryCount: p.inventoryCount ?? 0,
			unitCost: p.unitCost ? Number(p.unitCost) : null,
			unit: p.unitOfMeasure ?? 'ea',
			unitOfMeasure: p.unitOfMeasure ?? 'ea',
			minimumStockLevel: p.minimumOrderQty ?? null,
			reorderPoint: p.minimumOrderQty ?? null,
			supplier: p.supplier ?? null,
			manufacturer: p.manufacturer ?? null,
			vendorPartNumber: p.vendorPartNumber ?? null,
			leadTimeDays: p.leadTimeDays ?? null,
			hazardClass: p.hazardClass ?? null,
			certifications: p.certifications ?? null,
			expirationDate: p.expirationDate ?? null,
			msdsFileId: p.msdsFileId ?? null,
			inspectionPathway: p.inspectionPathway ?? null,
			scanRequired: p.scanRequired ?? false,
			isActive: p.isActive ?? true,
			sampleSize: p.sampleSize ?? 0,
			percentAccepted: p.percentAccepted ?? 100,
			createdAt: p.createdAt,
			updatedAt: p.updatedAt
		},
		inventoryTransactions: (transactions as any[]).map((t: any) => ({
			id: t._id,
			transactionType: t.transactionType ?? 'unknown',
			quantity: t.quantity ?? 0,
			previousQuantity: t.previousQuantity ?? 0,
			newQuantity: t.newQuantity ?? 0,
			performedByName: t.performedBy ?? null,
			performedAt: t.performedAt ?? t.createdAt,
			assemblySessionId: t.assemblySessionId ?? null,
			retractedAt: t.retractedAt ?? null,
			retractionReason: t.retractionReason ?? null,
			notes: t.reason ?? null
		})),
		versions,
		auditEntries,
		filters: { type: typeFilter, startDate, endDate, retracted: retractedFilter }
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
