import { fail, error } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import {
	connectDB,
	ReceivingLot,
	InspectionResult,
	ToolConfirmation,
	InspectionProcedureRevision,
	PartDefinition,
	InventoryTransaction,
	CartridgeRecord,
	ManufacturingMaterial,
	ManufacturingMaterialTransaction,
	AuditLog,
	generateId
} from '$lib/server/db';
import { normalizeDocUrl, normalizeDocUrls } from '$lib/server/url-utils';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	requirePermission(locals.user, 'inventory:read');
	await connectDB();

	const lot = await ReceivingLot.findById(params.lotId).lean() as any;
	if (!lot) throw error(404, 'Receiving lot not found');

	// Fetch related data in parallel
	const lotIdentifiers = [lot._id, lot.lotId].filter(Boolean);

	const [inspectionResults, toolConfirmations, ipRevision, lotTransactions, linkedCartridges] = await Promise.all([
		InspectionResult.find({ lotId: lot._id }).sort({ sampleNumber: 1, stepOrder: 1 }).lean(),
		ToolConfirmation.find({ lotId: lot._id }).lean(),
		lot.ipRevisionId
			? InspectionProcedureRevision.findById(lot.ipRevisionId).lean()
			: Promise.resolve(null),
		// S5: Fetch all inventory transactions referencing this lot
		InventoryTransaction.find({ lotId: { $in: lotIdentifiers } })
			.sort({ performedAt: -1 })
			.limit(500)
			.lean(),
		// S5: Find cartridges that consumed material from this lot
		CartridgeRecord.find({
			$or: [
				{ 'backing.lotId': { $in: lotIdentifiers } },
				{ 'waxFilling.waxSourceLot': { $in: lotIdentifiers } },
				{ 'topSeal.topSealLotId': { $in: lotIdentifiers } }
			]
		})
			.select('_id currentPhase backing.lotId waxFilling.waxSourceLot waxFilling.runId topSeal.topSealLotId reagentFilling.assayType.name createdAt')
			.sort({ createdAt: -1 })
			.limit(200)
			.lean()
	]);

	// Group transactions by manufacturing step
	const transactionsByStep: Record<string, any[]> = {};
	for (const tx of lotTransactions as any[]) {
		const step = tx.manufacturingStep ?? 'other';
		if (!transactionsByStep[step]) transactionsByStep[step] = [];
		transactionsByStep[step].push({
			id: tx._id,
			transactionType: tx.transactionType,
			quantity: tx.quantity,
			previousQuantity: tx.previousQuantity,
			newQuantity: tx.newQuantity,
			manufacturingStep: tx.manufacturingStep,
			manufacturingRunId: tx.manufacturingRunId,
			cartridgeRecordId: tx.cartridgeRecordId,
			operatorUsername: tx.operatorUsername ?? tx.performedBy,
			performedAt: tx.performedAt,
			notes: tx.notes ?? tx.reason
		});
	}

	// Summary stats
	const usageSummary = {
		totalTransactions: (lotTransactions as any[]).length,
		totalConsumed: (lotTransactions as any[]).filter((t: any) => t.transactionType === 'consumption').reduce((s: number, t: any) => s + Math.abs(t.quantity ?? 0), 0),
		totalCreated: (lotTransactions as any[]).filter((t: any) => t.transactionType === 'creation').reduce((s: number, t: any) => s + Math.abs(t.quantity ?? 0), 0),
		totalScrapped: (lotTransactions as any[]).filter((t: any) => t.transactionType === 'scrap').reduce((s: number, t: any) => s + Math.abs(t.quantity ?? 0), 0),
		linkedCartridgeCount: (linkedCartridges as any[]).length
	};

	const lotData = lot as any;
	lotData.cocDocumentUrl = normalizeDocUrl(lotData.cocDocumentUrl);
	lotData.photos = normalizeDocUrls(lotData.photos ?? []);
	lotData.additionalDocuments = normalizeDocUrls(lotData.additionalDocuments ?? []);
	if (lotData.cocPhotos) { lotData.cocPhotos = lotData.cocPhotos.map((p: any) => ({ ...p, fileUrl: normalizeDocUrl(p.fileUrl) ?? p.fileUrl })); }

	return {
		lot: JSON.parse(JSON.stringify(lotData)),
		inspectionResults: JSON.parse(JSON.stringify(inspectionResults)),
		toolConfirmations: JSON.parse(JSON.stringify(toolConfirmations)),
		ipRevision: ipRevision ? JSON.parse(JSON.stringify(ipRevision)) : null,
		lotUsage: {
			transactionsByStep: JSON.parse(JSON.stringify(transactionsByStep)),
			linkedCartridges: JSON.parse(JSON.stringify((linkedCartridges as any[]).map((c: any) => ({
				cartridgeId: c._id,
				currentPhase: c.currentPhase ?? 'unknown',
				lotId: c.backing?.lotId ?? null,
				waxSourceLot: c.waxFilling?.waxSourceLot ?? null,
				topSealLotId: c.topSeal?.topSealLotId ?? null,
				waxRunId: c.waxFilling?.runId ?? null,
				assayType: c.reagentFilling?.assayType?.name ?? null,
				createdAt: c.createdAt
			})))),
			summary: usageSummary
		}
	};
};

export const actions: Actions = {
	/**
	 * S7: Dispose a receiving lot — change status from in_progress to final disposition.
	 * Handles inventory update on acceptance.
	 */
	disposeLot: async ({ request, locals, params }) => {
		requirePermission(locals.user, 'inventory:write');
		await connectDB();

		const formData = await request.formData();
		const dispositionType = formData.get('dispositionType')?.toString() as 'accepted' | 'rejected' | 'returned' | 'other';
		const totalRejects = formData.has('totalRejects') ? Number(formData.get('totalRejects')) : undefined;
		const defectDescription = formData.get('defectDescription')?.toString() || undefined;
		const rmaNumber = formData.get('rmaNumber')?.toString() || undefined;
		const dispositionExplanation = formData.get('dispositionExplanation')?.toString() || undefined;

		if (!dispositionType) return fail(400, { error: 'Disposition type is required' });

		const lot = await ReceivingLot.findById(params.lotId) as any;
		if (!lot) return fail(404, { error: 'Lot not found' });

		// Check immutability — completed lots cannot be modified
		if (lot.disposedAt && lot.status !== 'in_progress') {
			return fail(400, { error: 'This lot has already been dispositioned and cannot be modified.' });
		}

		const oldStatus = lot.status;
		const now = new Date();

		// Update lot with disposition
		lot.status = dispositionType;
		lot.dispositionType = dispositionType;
		lot.disposedAt = now;
		lot.disposedBy = { _id: locals.user!._id, username: locals.user!.username };

		if (dispositionType === 'rejected') {
			lot.ncNumber = lot.ncNumber || `NC-${Date.now()}`;
			lot.totalRejects = totalRejects;
			lot.defectDescription = defectDescription;
		}

		if (dispositionType === 'returned') {
			lot.rmaNumber = rmaNumber;
		}

		if (dispositionType === 'other') {
			lot.dispositionExplanation = dispositionExplanation;
		}

		await lot.save();

		// Update inventory on acceptance
		if (dispositionType === 'accepted' && lot.part?._id) {
			const partId = lot.part._id;
			const quantity = lot.quantity;
			const prevPart = await PartDefinition.findById(partId).lean() as any;
			const prevCount = prevPart?.inventoryCount ?? 0;
			const newCount = prevCount + quantity;

			await PartDefinition.updateOne(
				{ _id: partId },
				{ $inc: { inventoryCount: quantity } }
			);

			await InventoryTransaction.create({
				_id: generateId(),
				partDefinitionId: partId,
				lotId: lot._id,
				transactionType: 'receipt',
				quantity,
				previousQuantity: prevCount,
				newQuantity: newCount,
				reason: `Received lot ${lot.lotId} (${lot.lotNumber})`,
				performedBy: locals.user!._id,
				performedAt: now,
				operatorId: locals.user!._id,
				operatorUsername: locals.user!.username
			});

			// Sync ManufacturingMaterial if linked
			const mfgMaterial = await ManufacturingMaterial.findOne({ partDefinitionId: partId }).lean() as any;
			if (mfgMaterial) {
				const mfgBefore = mfgMaterial.currentQuantity ?? 0;
				const mfgAfter = mfgBefore + quantity;

				await ManufacturingMaterialTransaction.create({
					_id: generateId(),
					materialId: mfgMaterial._id,
					transactionType: 'receive',
					quantityChanged: quantity,
					quantityBefore: mfgBefore,
					quantityAfter: mfgAfter,
					operatorId: locals.user!._id,
					notes: `Received via lot ${lot.lotId}`,
					createdAt: now
				});

				await ManufacturingMaterial.findByIdAndUpdate(mfgMaterial._id, {
					$set: { currentQuantity: mfgAfter, updatedAt: now },
					$push: { recentTransactions: { $each: [{ transactionType: 'receive', quantityChanged: quantity, quantityBefore: mfgBefore, quantityAfter: mfgAfter, operatorId: locals.user!._id, notes: `Received via lot ${lot.lotId}`, createdAt: now }], $slice: -100 } }
				});
			}
		}

		// Audit log
		await AuditLog.create({
			_id: generateId(),
			tableName: 'receiving_lot',
			recordId: lot._id,
			action: 'UPDATE',
			oldData: { status: oldStatus },
			newData: {
				status: dispositionType,
				dispositionType,
				totalRejects,
				defectDescription,
				rmaNumber,
				ncNumber: lot.ncNumber
			},
			changedAt: now,
			changedBy: locals.user!._id
		});

		return { success: true, disposed: true };
	}
};

export const config = { maxDuration: 60 };
