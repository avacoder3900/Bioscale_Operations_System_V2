import { fail, error } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import {
	connectDB, AssemblySession, Spu, WorkInstruction, PartDefinition,
	BomItem, InventoryTransaction, generateId
} from '$lib/server/db';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	const session = await AssemblySession.findById(params.sessionId).lean();
	if (!session) throw error(404, 'Assembly session not found');
	const s = session as any;

	const spu = s.spuId ? await Spu.findById(s.spuId).lean() : null;
	const sp = spu as any;

	// Fetch work instruction if linked
	let workInstruction: { documentNumber: string } | null = null;
	let workInstructionSteps: any[] = [];

	if (s.workInstructionId) {
		const wi = await WorkInstruction.findById(s.workInstructionId).lean() as any;
		if (wi) {
			workInstruction = { documentNumber: wi.documentNumber ?? '' };
			const currentVersion = (wi.versions ?? []).find(
				(v: any) => v.version === wi.currentVersion
			) ?? (wi.versions ?? []).slice(-1)[0];
			workInstructionSteps = (currentVersion?.steps ?? []).map((step: any) => ({
				id: step._id,
				stepNumber: step.stepNumber ?? 0,
				title: step.title ?? '',
				content: step.content ?? '',
				requiresScan: step.requiresScan ?? false,
				scanPrompt: step.scanPrompt ?? null,
				partRequirements: (step.partRequirements ?? []).map((pr: any) => ({
					id: pr._id,
					partNumber: pr.partNumber ?? '',
					quantity: pr.quantity ?? 1
				})),
				fieldDefinitions: (step.fieldDefinitions ?? []).map((fd: any) => ({
					id: fd._id,
					fieldName: fd.fieldName ?? '',
					fieldLabel: fd.fieldLabel ?? '',
					fieldType: fd.fieldType ?? 'manual_entry',
					isRequired: fd.isRequired ?? false,
					validationPattern: fd.validationPattern ?? null,
					options: fd.options ?? null,
					barcodeFieldMapping: fd.barcodeFieldMapping ?? null,
					sortOrder: fd.sortOrder ?? 0
				}))
			}));
		}
	}

	// BOM parts (ordered) — spu BOM items
	const bomItems = await BomItem.find({ bomType: 'spu', isActive: true }).sort({ boxRowIndex: 1 }).lean();

	// Also fetch part definitions for inventory count
	const bomPartNumbers = (bomItems as any[]).map((b: any) => b.partNumber).filter(Boolean);
	const partDefs = await PartDefinition.find(
		bomPartNumbers.length ? { partNumber: { $in: bomPartNumbers } } : {}
	).lean();
	const partDefMap = new Map((partDefs as any[]).map((p: any) => [p.partNumber, p]));

	const parts = (bomItems as any[]).map((b: any) => {
		const partDef = partDefMap.get(b.partNumber);
		return {
			id: b._id,
			partNumber: b.partNumber ?? '',
			name: b.name ?? '',
			category: b.category ?? null,
			inventoryCount: partDef?.inventoryCount ?? b.inventoryCount ?? 0,
			hasInventoryTracking: true,
			bomData: {
				id: b._id,
				quantityPerUnit: b.quantityPerUnit ?? 1,
				unitCost: b.unitCost ?? null
			}
		};
	});

	// Scanned parts from SPU
	const scannedParts = (sp?.parts ?? []).map((p: any) => ({
		id: p._id,
		partDefinitionId: p.partDefinitionId ?? '',
		lotNumber: p.lotNumber ?? null,
		partNumber: p.partNumber ?? '',
		partName: p.partName ?? '',
		scannedAt: p.scannedAt ?? null
	}));

	// Step records from assembly session
	const stepRecords = s.stepRecords ?? [];
	const completedStepRecords = stepRecords.map((sr: any) => ({
		id: sr._id,
		workInstructionStepId: sr.workInstructionStepId ?? null,
		stepNumber: sr.stepNumber ?? 0,
		scannedLotNumber: sr.scannedLotNumber ?? null,
		scannedPartNumber: sr.scannedPartNumber ?? null,
		completedAt: sr.completedAt ?? null
	}));

	// Captured field records from all step records
	const capturedFieldRecords = stepRecords.flatMap((sr: any) =>
		(sr.fieldRecords ?? []).map((fr: any) => ({
			id: fr._id,
			stepFieldDefinitionId: fr.stepFieldDefinitionId ?? null,
			fieldName: fr.fieldName ?? '',
			fieldValue: fr.fieldValue ?? '',
			bomItemId: fr.bomItemId ?? null,
			capturedAt: fr.scannedAt ?? fr.enteredAt ?? null
		}))
	);

	// Inventory transactions for this session
	const rawTxns = await InventoryTransaction.find(
		{ assemblySessionId: params.sessionId }
	).sort({ performedAt: -1 }).lean();

	// Look up part names for transactions
	const txnPartIds = [...new Set((rawTxns as any[]).map((t: any) => t.partDefinitionId).filter(Boolean))];
	const txnParts = txnPartIds.length
		? await PartDefinition.find({ _id: { $in: txnPartIds } }, { partNumber: 1, name: 1 }).lean()
		: [];
	const txnPartMap = new Map((txnParts as any[]).map((p: any) => [p._id, p]));

	const inventoryTransactions = (rawTxns as any[]).map((t: any) => {
		const pDef = txnPartMap.get(t.partDefinitionId);
		return {
			id: t._id,
			partDefinitionId: t.partDefinitionId ?? null,
			partNumber: pDef?.partNumber ?? '',
			partName: pDef?.name ?? '',
			transactionType: t.transactionType ?? 'deduction',
			quantity: t.quantity ?? 0,
			previousQuantity: t.previousQuantity ?? 0,
			newQuantity: t.newQuantity ?? 0,
			performedByName: t.performedBy ?? null,
			performedAt: t.performedAt ?? null,
			retractedAt: t.retractedAt ?? null,
			retractionReason: t.retractionReason ?? null
		};
	});

	// Permission check for retraction
	const canRetract = !!(locals.user as any)?.permissions?.includes('inventory:retract')
		|| !!(locals.user as any)?.roles?.some((r: any) =>
			r.permissions?.includes('inventory:retract') || r.roleName === 'admin'
		);

	return {
		session: {
			id: s._id,
			spuId: s.spuId ?? '',
			status: s.status,
			currentStepIndex: s.currentStepIndex ?? 0,
			startedAt: s.startedAt ?? s.createdAt,
			completedAt: s.completedAt ?? null,
			workInstructionId: s.workInstructionId ?? null
		},
		spu: {
			udi: sp?.udi ?? '',
			id: sp?._id ?? ''
		},
		workInstruction,
		workInstructionSteps,
		parts,
		scannedParts,
		completedStepRecords,
		capturedFieldRecords,
		inventoryTransactions,
		canRetract
	};
};

export const actions: Actions = {
	captureField: async ({ request, locals, params }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const assemblyStepRecordId = form.get('assemblyStepRecordId')?.toString();
		const stepFieldDefinitionId = form.get('stepFieldDefinitionId')?.toString();
		const rawValue = form.get('rawValue')?.toString();
		const isBarcodeScan = form.get('isBarcodeScan') === 'true';

		if (!stepFieldDefinitionId || rawValue === undefined) {
			return fail(400, { error: 'Field definition ID and value required' });
		}

		const session = await AssemblySession.findById(params.sessionId);
		if (!session) return fail(404, { error: 'Session not found' });
		const s = session as any;

		// Find or create the step record for the current WI step
		let stepRecord = (s.stepRecords ?? []).find(
			(sr: any) => sr.workInstructionStepId === assemblyStepRecordId
		);

		if (!stepRecord) {
			// Create new step record
			const newSr = {
				_id: generateId(),
				workInstructionStepId: assemblyStepRecordId ?? '',
				stepNumber: (s.stepRecords?.length ?? 0) + 1,
				fieldRecords: []
			};
			if (!s.stepRecords) s.stepRecords = [];
			s.stepRecords.push(newSr);
			stepRecord = s.stepRecords[s.stepRecords.length - 1];
		}

		if (!stepRecord.fieldRecords) stepRecord.fieldRecords = [];
		stepRecord.fieldRecords.push({
			_id: generateId(),
			stepFieldDefinitionId,
			fieldValue: rawValue,
			rawBarcodeData: isBarcodeScan ? rawValue : null,
			scannedAt: new Date(),
			capturedBy: locals.user!._id
		});

		await session.save();
		return { success: true, bomItemLinked: false };
	},

	scanPart: async ({ request, locals, params }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const barcode = form.get('barcode')?.toString();
		const partDefinitionId = form.get('partDefinitionId')?.toString();
		const workInstructionStepId = form.get('workInstructionStepId')?.toString();

		if (!barcode) return fail(400, { error: 'Barcode required' });

		const session = await AssemblySession.findById(params.sessionId);
		if (!session) return fail(404, { error: 'Session not found' });
		const s = session as any;

		// Parse lot number from barcode (simple extraction)
		const lotNumber = barcode;

		// Get part info
		let partDef: any = null;
		if (partDefinitionId) {
			partDef = await PartDefinition.findById(partDefinitionId).lean();
		}

		// Add step record for WI step if provided
		if (workInstructionStepId) {
			if (!s.stepRecords) s.stepRecords = [];
			const existingRecord = s.stepRecords.find(
				(sr: any) => sr.workInstructionStepId === workInstructionStepId
			);
			if (!existingRecord) {
				s.stepRecords.push({
					_id: generateId(),
					workInstructionStepId,
					stepNumber: s.stepRecords.length + 1,
					scannedLotNumber: lotNumber,
					scannedPartNumber: partDef?.partNumber ?? '',
					completedAt: new Date(),
					completedBy: { _id: locals.user!._id, username: locals.user!.username }
				});
			}
		} else {
			// Parts-only mode: advance step index
			s.currentStepIndex = (s.currentStepIndex ?? 0) + 1;
		}

		await session.save();

		// Add scanned part to SPU
		let inventoryDeduction = null;
		if (s.spuId) {
			await Spu.updateOne({ _id: s.spuId }, {
				$push: {
					parts: {
						_id: generateId(),
						partDefinitionId: partDefinitionId ?? null,
						partNumber: partDef?.partNumber ?? '',
						partName: partDef?.name ?? '',
						lotNumber,
						barcodeData: barcode,
						scannedAt: new Date(),
						scannedBy: { _id: locals.user!._id, username: locals.user!.username }
					}
				}
			});

			// Inventory deduction if part has tracking
			if (partDefinitionId && partDef) {
				const prevQty = (partDef as any).inventoryCount ?? 0;
				const newQty = Math.max(0, prevQty - 1);
				await PartDefinition.updateOne({ _id: partDefinitionId }, { $inc: { inventoryCount: -1 } });
				await InventoryTransaction.create({
					_id: generateId(),
					partDefinitionId,
					assemblySessionId: params.sessionId,
					transactionType: 'deduction',
					quantity: -1,
					previousQuantity: prevQty,
					newQuantity: newQty,
					reason: `Assembly scan for SPU ${s.spuId}`,
					performedBy: locals.user!.username,
					performedAt: new Date()
				});
				inventoryDeduction = { previousQuantity: prevQty, newQuantity: newQty };
			}
		}

		return { success: true, inventoryDeduction };
	},

	retractInventory: async ({ request, locals, params }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const transactionId = form.get('transactionId')?.toString();
		const reason = form.get('reason')?.toString();

		if (!transactionId || !reason) return fail(400, { error: 'Transaction ID and reason required' });

		const txn = await InventoryTransaction.findById(transactionId).lean() as any;
		if (!txn) return fail(404, { error: 'Transaction not found' });
		if (txn.retractedAt) return fail(400, { error: 'Transaction already retracted' });

		// Restore inventory
		if (txn.partDefinitionId) {
			await PartDefinition.updateOne(
				{ _id: txn.partDefinitionId },
				{ $inc: { inventoryCount: Math.abs(txn.quantity) } }
			);
		}

		await InventoryTransaction.updateOne({ _id: transactionId }, {
			$set: {
				retractedAt: new Date(),
				retractedBy: locals.user!.username,
				retractionReason: reason
			}
		});

		return { success: true };
	},

	pause: async ({ locals, params }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		await AssemblySession.updateOne({ _id: params.sessionId }, {
			$set: { status: 'paused', pausedAt: new Date() }
		});
		return { success: true };
	},

	resume: async ({ locals, params }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		await AssemblySession.updateOne({ _id: params.sessionId }, {
			$set: { status: 'in_progress' },
			$unset: { pausedAt: '' }
		});
		return { success: true };
	}
};
