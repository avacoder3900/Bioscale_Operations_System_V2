import { fail, error } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, PartDefinition, InventoryTransaction, LotRecord, AuditLog, generateId } from '$lib/server/db';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params, url }) => {
	requirePermission(locals.user, 'inventory:read');
	await connectDB();

	const part = await PartDefinition.findById(params.partId).lean();
	if (!part) throw error(404, 'Part not found');
	const p = part as any;

	const typeFilter = url.searchParams.get('type') ?? '';
	const startDate = url.searchParams.get('startDate') ?? '';
	const endDate = url.searchParams.get('endDate') ?? '';
	const retractedFilter = url.searchParams.get('retracted') ?? '';

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
			quantityPerUnit: p.quantityPerUnit ?? null,
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
			bomType: p.bomType ?? null,
			boxRowIndex: p.boxRowIndex ?? null,
			inspectionConfig: {
				sampleSize: p.sampleSize ?? 1,
				percentAccepted: p.percentAccepted ?? 100
			},
			createdAt: p.createdAt,
			updatedAt: p.updatedAt
		},
		sampleSize: p.sampleSize ?? 1,
		percentAccepted: p.percentAccepted ?? 100,
		partDefinitionId: p._id,
		ipRevisions: [],
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
	adjustInventory: async ({ request, locals, params }) => {
		requirePermission(locals.user, 'inventory:write');
		await connectDB();
		const form = await request.formData();
		const adjustment = Number(form.get('adjustment'));
		const reason = form.get('reason')?.toString() ?? 'Manual adjustment';
		if (isNaN(adjustment)) return fail(400, { error: 'Invalid adjustment' });
		const part = await PartDefinition.findById(params.partId) as any;
		if (!part) return fail(404, { error: 'Part not found' });
		const prevQty = part.inventoryCount ?? 0;
		const newQty = prevQty + adjustment;
		part.inventoryCount = newQty;
		await part.save();
		await InventoryTransaction.create({
			_id: generateId(),
			partDefinitionId: params.partId,
			transactionType: adjustment > 0 ? 'addition' : 'deduction',
			quantity: adjustment,
			previousQuantity: prevQty,
			newQuantity: newQty,
			reason,
			performedBy: locals.user!.username,
			performedAt: new Date()
		});
		return { success: true };
	},

	retractTransaction: async ({ request, locals, params }) => {
		requirePermission(locals.user, 'inventory:write');
		await connectDB();
		const form = await request.formData();
		const transactionId = form.get('transactionId')?.toString();
		const reason = form.get('reason')?.toString() ?? '';
		if (!transactionId) return fail(400, { error: 'Transaction ID required' });
		const txn = await InventoryTransaction.findById(transactionId).lean() as any;
		if (!txn) return fail(404, { error: 'Transaction not found' });
		if (txn.retractedAt) return fail(400, { error: 'Already retracted' });
		if (txn.partDefinitionId) {
			await PartDefinition.updateOne({ _id: txn.partDefinitionId }, { $inc: { inventoryCount: Math.abs(txn.quantity) } });
		}
		await InventoryTransaction.updateOne({ _id: transactionId }, { $set: { retractedAt: new Date(), retractedBy: locals.user!.username, retractionReason: reason } });
		return { success: true };
	},

	updateMinStockLevel: async ({ request, locals, params }) => {
		requirePermission(locals.user, 'inventory:write');
		await connectDB();
		const form = await request.formData();
		const minimumStockLevel = Number(form.get('minimumStockLevel'));
		if (isNaN(minimumStockLevel) || minimumStockLevel < 0) {
			return fail(400, { error: 'Invalid minimum stock level' });
		}
		const part = await PartDefinition.findById(params.partId) as any;
		if (!part) return fail(404, { error: 'Part not found' });

		const oldValue = part.minimumOrderQty ?? 0;
		part.minimumOrderQty = minimumStockLevel;
		await part.save();

		await AuditLog.create({
			_id: generateId(),
			tableName: 'part_definitions',
			recordId: params.partId,
			action: 'UPDATE',
			oldData: { minimumOrderQty: oldValue },
			newData: { minimumOrderQty: minimumStockLevel },
			changedAt: new Date(),
			changedBy: locals.user!.username,
			changedFields: ['minimumOrderQty']
		});

		return { success: true };
	},

	updateInspectionConfig: async ({ request, locals, params }) => {
		requirePermission(locals.user, 'inventory:write');
		await connectDB();
		const form = await request.formData();
		const sampleSize = Number(form.get('sampleSize'));
		const percentAccepted = Number(form.get('percentAccepted'));
		if (isNaN(sampleSize) || sampleSize < 1) {
			return fail(400, { inspectionConfigError: 'Sample size must be at least 1' });
		}
		if (isNaN(percentAccepted) || percentAccepted < 0 || percentAccepted > 100) {
			return fail(400, { inspectionConfigError: 'Percent accepted must be between 0 and 100' });
		}
		const part = await PartDefinition.findById(params.partId) as any;
		if (!part) return fail(404, { inspectionConfigError: 'Part not found' });

		const oldSampleSize = part.sampleSize ?? 0;
		const oldPercentAccepted = part.percentAccepted ?? 100;
		part.sampleSize = sampleSize;
		part.percentAccepted = percentAccepted;
		await part.save();

		await AuditLog.create({
			_id: generateId(),
			tableName: 'part_definitions',
			recordId: params.partId,
			action: 'UPDATE',
			oldData: { sampleSize: oldSampleSize, percentAccepted: oldPercentAccepted },
			newData: { sampleSize, percentAccepted },
			changedAt: new Date(),
			changedBy: locals.user!.username,
			changedFields: ['sampleSize', 'percentAccepted']
		});

		return { inspectionConfigSuccess: true };
	}
};
