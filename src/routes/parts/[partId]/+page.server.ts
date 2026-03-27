import { fail, error } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, PartDefinition, InventoryTransaction, InspectionProcedureRevision, LotRecord, ReceivingLot, AuditLog, generateId } from '$lib/server/db';
import { uploadFile } from '$lib/server/box';
import { env } from '$env/dynamic/private';
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
	const operatorFilter = url.searchParams.get('operator') ?? '';

	const txFilter: Record<string, any> = { partDefinitionId: params.partId };
	if (typeFilter) txFilter.transactionType = typeFilter;
	if (startDate || endDate) {
		txFilter.performedAt = {};
		if (startDate) txFilter.performedAt.$gte = new Date(startDate);
		if (endDate) txFilter.performedAt.$lte = new Date(endDate);
	}
	if (retractedFilter === 'true') txFilter.retractedAt = { $exists: true, $ne: null };
	if (retractedFilter === 'false') txFilter.retractedAt = { $exists: false };
	if (operatorFilter) {
		txFilter.$or = [
			{ operatorId: operatorFilter },
			{ operatorUsername: operatorFilter },
			{ performedBy: operatorFilter }
		];
	}

	const [lots, transactions, ipRevisionDocs, receivingLots] = await Promise.all([
		LotRecord.find({ partDefinitionId: params.partId }).sort({ createdAt: -1 }).lean(),
		InventoryTransaction.find(txFilter).sort({ performedAt: -1 }).limit(200).lean(),
		InspectionProcedureRevision.find({ partId: params.partId }).sort({ revisionNumber: -1 }).lean(),
		ReceivingLot.find({ 'part._id': params.partId }).sort({ createdAt: -1 }).lean()
	]);

	// Build a map of lotId -> cocDocumentUrl for transactions that reference a receiving lot
	const txLotIds = [...new Set((transactions as any[]).map((t: any) => t.lotId).filter(Boolean))];
	const cocMap: Record<string, string> = {};
	if (txLotIds.length > 0) {
		const receivingLots = await ReceivingLot.find(
			{ $or: [{ _id: { $in: txLotIds } }, { lotId: { $in: txLotIds } }] },
			{ _id: 1, lotId: 1, cocDocumentUrl: 1, photos: 1 }
		).lean() as any[];
		for (const rl of receivingLots) {
			if (rl.cocDocumentUrl || (rl.photos && rl.photos.length > 0)) {
				cocMap[rl._id] = rl.cocDocumentUrl ?? rl.photos?.[0] ?? null;
				if (rl.lotId) cocMap[rl.lotId] = rl.cocDocumentUrl ?? rl.photos?.[0] ?? null;
			}
		}
	}

	const versions = (lots as any[]).map((l: any, idx: number) => ({
		id: l._id,
		version: idx + 1,
		versionNumber: idx + 1,
		lotNumber: l.lotNumber ?? '',
		quantity: l.quantityProduced ?? l.desiredQuantity ?? 0,
		status: l.status ?? 'completed',
		changeType: l.changeType ?? (idx === 0 ? 'create' : 'update'),
		changedAt: l.createdAt ?? l.startTime,
		changeReason: l.changeReason ?? null,
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
			barcode: p.barcode ?? null,
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
		ipRevisions: JSON.parse(JSON.stringify((ipRevisionDocs as any[]).map((r: any) => ({
			id: r._id,
			revisionNumber: r.revisionNumber,
			documentUrl: r.documentUrl,
			renderedHtmlUrl: r.renderedHtmlUrl ?? null,
			formDefinition: r.formDefinition ?? null,
			changeNotes: r.changeNotes ?? null,
			isCurrent: r.isCurrent ?? false,
			uploadedAt: r.createdAt,
			uploadedByName: r.uploadedBy?.username ?? null
		})))),
		inventoryTransactions: (transactions as any[]).map((t: any) => ({
			id: t._id,
			transactionType: t.transactionType ?? 'unknown',
			quantity: t.quantity ?? 0,
			previousQuantity: t.previousQuantity ?? 0,
			newQuantity: t.newQuantity ?? 0,
			performedByName: t.operatorUsername ?? t.performedBy ?? null,
			performedAt: t.performedAt ?? t.createdAt,
			assemblySessionId: t.assemblySessionId ?? null,
			retractedAt: t.retractedAt ?? null,
			retractionReason: t.retractionReason ?? null,
			notes: t.notes ?? t.reason ?? null,
			lotId: t.lotId ?? null,
			cocUrl: t.lotId ? (cocMap[t.lotId] ?? null) : null,
			cartridgeRecordId: t.cartridgeRecordId ?? null,
			manufacturingStep: t.manufacturingStep ?? null,
			manufacturingRunId: t.manufacturingRunId ?? null
		})),
		transactionSummary: (() => {
			const all = transactions as any[];
			const nonRetracted = all.filter((t: any) => !t.retractedAt);
			return {
				totalReceived: nonRetracted.filter((t: any) => t.transactionType === 'receipt').reduce((s: number, t: any) => s + Math.abs(t.quantity ?? 0), 0),
				totalConsumed: nonRetracted.filter((t: any) => t.transactionType === 'consumption' || t.transactionType === 'deduction').reduce((s: number, t: any) => s + Math.abs(t.quantity ?? 0), 0),
				totalCreated: nonRetracted.filter((t: any) => t.transactionType === 'creation').reduce((s: number, t: any) => s + Math.abs(t.quantity ?? 0), 0),
				totalScrapped: nonRetracted.filter((t: any) => t.transactionType === 'scrap').reduce((s: number, t: any) => s + Math.abs(t.quantity ?? 0), 0),
				totalAdjusted: nonRetracted.filter((t: any) => t.transactionType === 'adjustment').reduce((s: number, t: any) => s + (t.quantity ?? 0), 0),
				currentCount: p.inventoryCount ?? 0,
				transactionCount: all.length
			};
		})(),
		receivingLots: JSON.parse(JSON.stringify((receivingLots as any[]).map((rl: any) => ({
			id: rl._id,
			lotNumber: rl.lotNumber ?? '',
			lotId: rl.lotId ?? '',
			quantity: rl.quantity ?? 0,
			status: rl.status ?? 'pending',
			operator: rl.operator?.username ?? null,
			bagBarcode: rl.bagBarcode ?? null,
			cocDocumentUrl: rl.cocDocumentUrl ?? null,
			createdAt: rl.createdAt
		})))),
		receivingLotsTotalQty: (receivingLots as any[]).reduce((sum: number, rl: any) => sum + (rl.quantity ?? 0), 0),
		versions,
		auditEntries,
		filters: { type: typeFilter, startDate, endDate, retracted: retractedFilter, operator: operatorFilter }
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

	editTransaction: async ({ request, locals, params }) => {
		requirePermission(locals.user, 'admin:full');
		await connectDB();
		const form = await request.formData();
		const transactionId = form.get('transactionId')?.toString();
		const newQuantity = Number(form.get('newQuantity'));
		const reason = form.get('reason')?.toString() ?? 'Admin correction';
		if (!transactionId) return fail(400, { error: 'Transaction ID required' });
		if (isNaN(newQuantity)) return fail(400, { error: 'Invalid quantity' });

		const txn = await InventoryTransaction.findById(transactionId).lean() as any;
		if (!txn) return fail(404, { error: 'Transaction not found' });

		const oldQty = txn.quantity ?? 0;
		const diff = newQuantity - oldQty;

		// Update the transaction
		await InventoryTransaction.updateOne({ _id: transactionId }, {
			$set: {
				quantity: newQuantity,
				newQuantity: (txn.previousQuantity ?? 0) + newQuantity,
				notes: `${txn.notes || txn.reason || ''} [ADMIN EDIT: was ${oldQty}, now ${newQuantity}. Reason: ${reason}]`
			}
		});

		// Adjust part inventory count by the difference
		if (txn.partDefinitionId) {
			await PartDefinition.updateOne({ _id: txn.partDefinitionId }, { $inc: { inventoryCount: diff } });
		}

		// Audit log
		await AuditLog.create({
			_id: generateId(),
			tableName: 'inventory_transactions',
			recordId: transactionId,
			action: 'UPDATE',
			oldData: { quantity: oldQty },
			newData: { quantity: newQuantity },
			changedAt: new Date(),
			changedBy: locals.user!.username,
			changedFields: ['quantity'],
			reason: `Admin correction: ${reason}`
		});

		return { editSuccess: true };
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
	},

	updateBarcode: async ({ request, locals, params }) => {
		requirePermission(locals.user, 'inventory:write');
		await connectDB();
		const form = await request.formData();
		const barcode = form.get('barcode')?.toString()?.trim() || null;

		const part = await PartDefinition.findById(params.partId) as any;
		if (!part) return fail(404, { error: 'Part not found' });

		if (barcode) {
			const existing = await PartDefinition.findOne({ barcode, _id: { $ne: params.partId } }).lean() as any;
			if (existing) return fail(400, { error: `Barcode already assigned to ${existing.partNumber ?? existing._id}` });
		}

		const oldBarcode = part.barcode ?? null;
		part.barcode = barcode;
		await part.save();

		await AuditLog.create({
			_id: generateId(),
			tableName: 'part_definitions',
			recordId: params.partId,
			action: 'UPDATE',
			oldData: { barcode: oldBarcode },
			newData: { barcode },
			changedAt: new Date(),
			changedBy: locals.user!.username,
			changedFields: ['barcode']
		});

		return { barcodeSuccess: true };
	},

	/**
	 * Upload a new inspection procedure revision (Word doc).
	 * Archives old current revision and creates new one.
	 */
	uploadIpRevision: async ({ request, locals, params }) => {
		requirePermission(locals.user, 'inventory:write');
		await connectDB();

		const formData = await request.formData();
		const file = formData.get('file') as File | null;
		const changeNotes = formData.get('changeNotes')?.toString() || undefined;
		const partDefinitionId = formData.get('partDefinitionId')?.toString() || params.partId;

		if (!file || file.size === 0) {
			return fail(400, { ipError: 'A .docx file is required' });
		}

		try {
			// Upload the file to Box.com
			const buffer = await file.arrayBuffer();
			const timestamp = Date.now();
			const fileName = `ip-${partDefinitionId}-rev-${timestamp}.docx`;
			const folderId = env.BOX_ROOT_FOLDER_ID ?? '0';
			const uploaded = await uploadFile(folderId, fileName, buffer);
			const documentUrl = `https://app.box.com/files/${uploaded.id}`;

			// Find the current highest revision number for this part
			const latestRev = await InspectionProcedureRevision.findOne(
				{ partId: partDefinitionId },
				{ revisionNumber: 1 },
				{ sort: { revisionNumber: -1 } }
			).lean() as any;

			const nextRevNumber = (latestRev?.revisionNumber ?? 0) + 1;

			// Archive all current revisions for this part
			await InspectionProcedureRevision.updateMany(
				{ partId: partDefinitionId, isCurrent: true },
				{ $set: { isCurrent: false } }
			);

			// Create new revision
			const revision = await InspectionProcedureRevision.create({
				_id: generateId(),
				partId: partDefinitionId,
				revisionNumber: nextRevNumber,
				documentUrl,
				uploadedBy: {
					_id: locals.user!._id,
					username: locals.user!.username
				},
				changeNotes,
				isCurrent: true
			});

			await AuditLog.create({
				_id: generateId(),
				tableName: 'inspection_procedure_revisions',
				recordId: revision._id,
				action: 'INSERT',
				oldData: null,
				newData: { partId: partDefinitionId, revisionNumber: nextRevNumber, documentUrl },
				changedAt: new Date(),
				changedBy: locals.user!._id
			});

			return { ipSuccess: true };
		} catch (err) {
			return fail(500, { ipError: err instanceof Error ? err.message : 'Upload failed' });
		}
	},

	/**
	 * Save or update the form definition JSON for an inspection procedure revision.
	 */
	saveFormDefinition: async ({ request, locals }) => {
		requirePermission(locals.user, 'inventory:write');
		await connectDB();

		const formData = await request.formData();
		const revisionId = formData.get('revisionId')?.toString();
		const formDefJson = formData.get('formDefinition')?.toString();

		if (!revisionId) return fail(400, { formDefError: 'Revision ID is required' });
		if (!formDefJson) return fail(400, { formDefError: 'Form definition is required' });

		let formDefinition: unknown;
		try {
			formDefinition = JSON.parse(formDefJson);
		} catch {
			return fail(400, { formDefError: 'Invalid JSON' });
		}

		const revision = await InspectionProcedureRevision.findById(revisionId) as any;
		if (!revision) return fail(404, { formDefError: 'Revision not found' });

		const oldDef = revision.formDefinition;
		revision.formDefinition = formDefinition;
		await revision.save();

		await AuditLog.create({
			_id: generateId(),
			tableName: 'inspection_procedure_revisions',
			recordId: revisionId,
			action: 'UPDATE',
			oldData: { formDefinition: oldDef },
			newData: { formDefinition },
			changedAt: new Date(),
			changedBy: locals.user!._id,
			changedFields: ['formDefinition']
		});

		return { formDefSuccess: true };
	}
};

export const config = { maxDuration: 60 };
