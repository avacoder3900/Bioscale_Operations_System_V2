import { fail } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import {
	connectDB,
	PartDefinition,
	InspectionProcedureRevision,
	ReceivingLot,
	InspectionResult,
	ToolConfirmation,
	InventoryTransaction,
	ManufacturingMaterial,
	ManufacturingMaterialTransaction,
	AuditLog,
	generateId,
	generateLotNumber
} from '$lib/server/db';
import { env } from '$env/dynamic/private';
import { uploadFile } from '$lib/server/box';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'inventory:read');
	await connectDB();

	const [parts, currentRevisions] = await Promise.all([
		PartDefinition.find({ isActive: true })
			.select('partNumber name category manufacturer supplier inventoryCount inspectionPathway sampleSize percentAccepted')
			.sort({ sortOrder: 1, name: 1 })
			.lean(),
		InspectionProcedureRevision.find({ isCurrent: true }).lean()
	]);

	// Build a map of partId -> current IP revision
	const ipRevisionMap: Record<
		string,
		{
			id: string;
			formDefinition: unknown;
			revisionNumber: number;
			renderedHtmlUrl: string | null;
			uploadedAt: Date;
		}
	> = {};

	for (const rev of currentRevisions as any[]) {
		ipRevisionMap[rev.partId] = {
			id: rev._id,
			formDefinition: rev.formDefinition,
			revisionNumber: rev.revisionNumber,
			renderedHtmlUrl: rev.renderedHtmlUrl ?? null,
			uploadedAt: rev.createdAt
		};
	}

	return {
		parts: JSON.parse(JSON.stringify(
			(parts as any[]).map((p: any) => ({
				id: p._id,
				partNumber: p.partNumber ?? '',
				name: p.name ?? '',
				category: p.category ?? null,
				manufacturer: p.manufacturer ?? null,
				supplier: p.supplier ?? null,
				inventoryCount: p.inventoryCount ?? 0,
				inspectionPathway: p.inspectionPathway ?? 'coc',
				sampleSize: p.sampleSize ?? 1,
				percentAccepted: p.percentAccepted ?? 100
			}))
		)),
		ipRevisionMap: JSON.parse(JSON.stringify(ipRevisionMap))
	};
};

export const actions: Actions = {
	/**
	 * Upload a Certificate of Conformance document to Box.com.
	 * Returns the Box.com file URL.
	 */
	uploadCoc: async ({ request, locals }) => {
		requirePermission(locals.user, 'inventory:write');

		const formData = await request.formData();
		const file = formData.get('cocFile') as File | null;
		const partId = formData.get('partId')?.toString();

		if (!file || !partId) return fail(400, { error: 'File and part are required' });

		try {
			const buffer = await file.arrayBuffer();
			const timestamp = Date.now();
			const ext = file.name.split('.').pop() ?? 'bin';
			const fileName = `coc-${partId}-${timestamp}.${ext}`;
			const folderId = env.BOX_ROOT_FOLDER_ID ?? '0';

			const uploaded = await uploadFile(folderId, fileName, buffer);
			const cocUrl = `https://app.box.com/files/${uploaded.id}`;
			return { success: true, cocUrl };
		} catch (err) {
			return fail(500, { error: err instanceof Error ? err.message : 'Upload failed' });
		}
	},

	/**
	 * Validate admin override password and reason.
	 */
	validateOverride: async ({ request, locals }) => {
		requirePermission(locals.user, 'inventory:write');

		const formData = await request.formData();
		const password = formData.get('adminPassword')?.toString();
		const reason = formData.get('overrideReason')?.toString();

		if (!reason || reason.length < 10) {
			return fail(400, { overrideError: 'Override reason must be at least 10 characters' });
		}

		if (!env.ADMIN_OVERRIDE_PASSWORD) {
			return fail(500, { overrideError: 'Override system not configured' });
		}

		if (password !== env.ADMIN_OVERRIDE_PASSWORD) {
			return fail(403, { overrideError: 'Invalid admin password' });
		}

		return { overrideApproved: true };
	},

	/**
	 * Create a receiving lot record.
	 * Handles: COC pathway, IP pathway with inspection results, tool confirmations,
	 * override workflow, rejection, inventory update, photo/document uploads.
	 */
	createLot: async ({ request, locals }) => {
		requirePermission(locals.user, 'inventory:write');
		await connectDB();

		const formData = await request.formData();
		const lotId = formData.get('lotId')?.toString()?.trim();
		const partId = formData.get('partId')?.toString();
		const quantity = Number(formData.get('quantity'));
		const pathway = formData.get('pathway')?.toString() as 'coc' | 'ip';
		const cocDocumentUrl = formData.get('cocDocumentUrl')?.toString() || undefined;
		const cocMeetsStandards = formData.has('cocMeetsStandards') ? formData.get('cocMeetsStandards') === 'true' : undefined;
		const poReference = formData.get('poReference')?.toString() || undefined;
		const supplier = formData.get('supplier')?.toString() || undefined;
		const vendorLotNumber = formData.get('vendorLotNumber')?.toString() || undefined;
		const serialNumber = formData.get('serialNumber')?.toString() || undefined;
		const expirationStr = formData.get('expirationDate')?.toString();
		const expirationDate = expirationStr ? new Date(expirationStr) : undefined;
		const ipRevisionId = formData.get('ipRevisionId')?.toString() || undefined;
		const confirmedToolsJson = formData.get('confirmedTools')?.toString();
		const inspectionResultsJson = formData.get('inspectionResults')?.toString();
		const overrideApplied = formData.get('overrideApplied') === 'true';
		const overrideReason = formData.get('overrideReason')?.toString() || undefined;
		const status = (formData.get('status')?.toString() as 'in_progress' | 'accepted' | 'rejected' | 'returned' | 'other') || 'accepted';

		// S3: First Article Inspection flag
		const firstArticleInspection = formData.get('firstArticleInspection') === 'true';

		// S2: Generic receiving checklist
		const checklistJson = formData.get('checklist')?.toString();
		const checklist = checklistJson ? JSON.parse(checklistJson) : undefined;
		const formFitFunctionCheck = formData.get('formFitFunctionCheck')?.toString() || undefined;
		const storageConditionsRequired = formData.get('storageConditionsRequired') === 'true';
		const esdHandlingRequired = formData.get('esdHandlingRequired') === 'true';

		// S6: Operator notes
		const notes = formData.get('notes')?.toString() || undefined;

		// S7: Disposition fields
		const totalRejects = formData.has('totalRejects') ? Number(formData.get('totalRejects')) : undefined;
		const defectDescription = formData.get('defectDescription')?.toString() || undefined;
		const rmaNumber = formData.get('rmaNumber')?.toString() || undefined;
		const dispositionExplanation = formData.get('dispositionExplanation')?.toString() || undefined;

		if (!lotId) return fail(400, { error: 'Lot ID (barcode) is required' });
		if (!partId) return fail(400, { error: 'Part is required' });
		if (!quantity || quantity <= 0) return fail(400, { error: 'Valid quantity is required' });

		// Check uniqueness of lotId barcode
		const existing = await ReceivingLot.findOne({ lotId }).lean();
		if (existing) return fail(400, { error: 'Lot ID already exists. Scan a different barcode.' });

		// Look up the part for denormalization
		const part = await PartDefinition.findById(partId).lean() as any;
		if (!part) return fail(404, { error: 'Part not found' });

		// Parse IP inspection results if present
		let ipResultsSummary: unknown = undefined;
		interface InspectionResultInput {
			sampleNumber: number;
			stepOrder: number;
			inputType: string;
			questionLabel: string;
			actualValue: string;
			result: string;
			toolUsed?: string;
			notes?: string;
		}
		const inspectionResultRows: InspectionResultInput[] = [];

		if (inspectionResultsJson) {
			const parsed = JSON.parse(inspectionResultsJson) as {
				result: string;
				passRate: number;
				percentRequired: number;
				responses: Record<string, Record<string, { value: string; result: string; notes?: string }>>;
				steps: { step_order: number; input_type: string; question_label: string; tool_id?: string }[];
			};
			ipResultsSummary = {
				result: parsed.result,
				passRate: parsed.passRate,
				percentRequired: parsed.percentRequired
			};
			const stepMap = new Map(parsed.steps.map((s) => [s.step_order, s]));
			for (const [sampleNum, stepResponses] of Object.entries(parsed.responses)) {
				for (const [stepOrder, resp] of Object.entries(stepResponses)) {
					const stepDef = stepMap.get(Number(stepOrder));
					inspectionResultRows.push({
						sampleNumber: Number(sampleNum),
						stepOrder: Number(stepOrder),
						inputType: stepDef?.input_type ?? 'unknown',
						questionLabel: stepDef?.question_label ?? '',
						actualValue: resp.value,
						result: resp.result,
						toolUsed: stepDef?.tool_id,
						notes: resp.notes
					});
				}
			}
		}

		// Handle photo and document uploads
		const photoFiles = formData.getAll('lotPhotos') as File[];
		const docFiles = formData.getAll('lotDocuments') as File[];
		const photoUrls: string[] = [];
		const docUrls: string[] = [];
		const folderId = env.BOX_ROOT_FOLDER_ID ?? '0';

		for (const file of photoFiles) {
			if (!file.size) continue;
			try {
				const buffer = await file.arrayBuffer();
				const ext = file.name.split('.').pop() ?? 'jpg';
				const fileName = `lot-photo-${lotId}-${Date.now()}.${ext}`;
				const uploaded = await uploadFile(folderId, fileName, buffer);
				photoUrls.push(`https://app.box.com/files/${uploaded.id}`);
			} catch {
				// Skip failed uploads silently
			}
		}

		for (const file of docFiles) {
			if (!file.size) continue;
			try {
				const buffer = await file.arrayBuffer();
				const ext = file.name.split('.').pop() ?? 'bin';
				const fileName = `lot-doc-${lotId}-${Date.now()}.${ext}`;
				const uploaded = await uploadFile(folderId, fileName, buffer);
				docUrls.push(`https://app.box.com/files/${uploaded.id}`);
			} catch {
				// Skip failed uploads silently
			}
		}

		try {
			// Generate system lot number (LOT-YYYYMMDD-XXXX)
			const lotNumber = await generateLotNumber(ReceivingLot);

			// Create the receiving lot
			const lot = await ReceivingLot.create({
				_id: generateId(),
				lotId,
				lotNumber,
				part: {
					_id: part._id,
					partNumber: part.partNumber ?? '',
					name: part.name ?? ''
				},
				quantity,
				serialNumber,
				operator: {
					_id: locals.user!._id,
					username: locals.user!.username
				},
				inspectionPathway: pathway,
				cocDocumentUrl,
				cocMeetsStandards,
				ipResults: ipResultsSummary,
				ipRevisionId,
				firstArticleInspection,
				poReference,
				supplier,
				vendorLotNumber,
				expirationDate,
				storageConditionsRequired,
				esdHandlingRequired,
				checklist,
				formFitFunctionCheck,
				notes,
				photos: photoUrls,
				additionalDocuments: docUrls,
				overrideApplied,
				overrideReason,
				overrideBy: overrideApplied
					? { _id: locals.user!._id, username: locals.user!.username }
					: undefined,
				overrideAt: overrideApplied ? new Date() : undefined,
				dispositionType: status !== 'in_progress' ? status : undefined,
				totalRejects,
				defectDescription,
				ncNumber: status === 'rejected' ? `NC-${Date.now()}` : undefined,
				rmaNumber,
				dispositionExplanation,
				disposedAt: status !== 'in_progress' ? new Date() : undefined,
				disposedBy: status !== 'in_progress'
					? { _id: locals.user!._id, username: locals.user!.username }
					: undefined,
				status
			});

			// Create tool confirmations if present
			if (confirmedToolsJson) {
				const confirmedTools = JSON.parse(confirmedToolsJson) as { tool_id: string; name: string }[];
				if (confirmedTools.length > 0) {
					await ToolConfirmation.insertMany(
						confirmedTools.map((t) => ({
							_id: generateId(),
							lotId: lot._id,
							toolId: t.tool_id,
							toolName: t.name,
							confirmedBy: {
								_id: locals.user!._id,
								username: locals.user!.username
							},
							confirmedAt: new Date()
						}))
					);
				}
			}

			// Create inspection results if present
			if (inspectionResultRows.length > 0) {
				await InspectionResult.insertMany(
					inspectionResultRows.map((r) => ({
						_id: generateId(),
						lotId: lot._id,
						sampleNumber: r.sampleNumber,
						stepOrder: r.stepOrder,
						inputType: r.inputType,
						questionLabel: r.questionLabel,
						actualValue: r.actualValue,
						result: r.result,
						toolUsed: r.toolUsed,
						notes: r.notes
					}))
				);
			}

			// Update inventory on acceptance
			if (status === 'accepted') {
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
					transactionType: 'receipt',
					quantity,
					previousQuantity: prevCount,
					newQuantity: newCount,
					reason: `Received lot ${lotId}`,
					performedBy: locals.user!._id,
					performedAt: new Date()
				});

				// FIX-04: Also sync ManufacturingMaterial if one is linked to this PartDefinition
				const mfgMaterial = await ManufacturingMaterial.findOne({ partDefinitionId: partId }).lean() as any;
				if (mfgMaterial) {
					const mfgBefore = mfgMaterial.currentQuantity ?? 0;
					const mfgAfter = mfgBefore + quantity;
					const now = new Date();

					await ManufacturingMaterialTransaction.create({
						_id: generateId(),
						materialId: mfgMaterial._id,
						transactionType: 'receive',
						quantityChanged: quantity,
						quantityBefore: mfgBefore,
						quantityAfter: mfgAfter,
						operatorId: locals.user!._id,
						notes: `Received via lot ${lotId}`,
						createdAt: now
					});

					const txEntry = {
						transactionType: 'receive',
						quantityChanged: quantity,
						quantityBefore: mfgBefore,
						quantityAfter: mfgAfter,
						operatorId: locals.user!._id,
						notes: `Received via lot ${lotId}`,
						createdAt: now
					};

					await ManufacturingMaterial.findByIdAndUpdate(mfgMaterial._id, {
						$set: { currentQuantity: mfgAfter, updatedAt: now },
						$push: { recentTransactions: { $each: [txEntry], $slice: -100 } }
					});
				}
			}

			// Audit log for override
			if (overrideApplied) {
				await AuditLog.create({
					_id: generateId(),
					tableName: 'receiving_lot',
					recordId: lot._id,
					action: 'UPDATE',
					oldData: { status: 'failed_inspection' },
					newData: {
						status: 'accepted_with_override',
						overrideReason,
						inspectionResult: ipResultsSummary
					},
					changedBy: locals.user!._id,
					changedAt: new Date()
				});
			}

			// Audit log for rejection
			if (status === 'rejected') {
				await AuditLog.create({
					_id: generateId(),
					tableName: 'receiving_lot',
					recordId: lot._id,
					action: 'UPDATE',
					oldData: null,
					newData: {
						status: 'rejected',
						inspectionResult: ipResultsSummary
					},
					changedBy: locals.user!._id,
					changedAt: new Date()
				});
			}

			return { success: true, lotCreated: true, lotId: lot._id, lotNumber };
		} catch (err) {
			console.error('[receiving/new] createLot error:', err);
			return fail(500, { error: err instanceof Error ? err.message : 'Failed to create lot' });
		}
	}
};

export const config = { maxDuration: 60 };
