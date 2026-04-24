import { fail, error } from '@sveltejs/kit';
import { requirePermission, hasPermission } from '$lib/server/permissions';
import {
	connectDB, AssemblySession, Spu, WorkInstruction, PartDefinition,
	BomItem, InventoryTransaction, generateId, AuditLog
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
				fieldDefinitions: (step.fieldDefinitions ?? [])
					.slice()
					.sort((a: any, b: any) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
					.map((fd: any) => ({
						id: fd._id,
						fieldName: fd.fieldName ?? '',
						fieldLabel: fd.fieldLabel ?? fd.fieldName ?? '',
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

	const bomItems = await BomItem.find({ bomType: 'spu', isActive: true }).sort({ boxRowIndex: 1 }).lean();
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
			inventoryCount: (partDef as any)?.inventoryCount ?? b.inventoryCount ?? 0,
			hasInventoryTracking: true,
			bomData: {
				id: b._id,
				quantityPerUnit: b.quantityPerUnit ?? 1,
				unitCost: b.unitCost ?? null
			}
		};
	});

	const scannedParts = (sp?.parts ?? []).map((p: any) => ({
		id: p._id,
		partDefinitionId: p.partDefinitionId ?? '',
		lotNumber: p.lotNumber ?? null,
		partNumber: p.partNumber ?? '',
		partName: p.partName ?? '',
		scannedAt: p.scannedAt ?? null
	}));

	const stepRecords = s.stepRecords ?? [];
	const completedStepRecords = stepRecords.map((sr: any) => ({
		id: sr._id,
		workInstructionStepId: sr.workInstructionStepId ?? null,
		stepNumber: sr.stepNumber ?? 0,
		scannedLotNumber: sr.scannedLotNumber ?? null,
		scannedPartNumber: sr.scannedPartNumber ?? null,
		completedAt: sr.completedAt ?? null
	}));

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

	const rawTxns = await InventoryTransaction.find(
		{ assemblySessionId: params.sessionId }
	).sort({ performedAt: -1 }).lean();

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

	const canRetract = hasPermission(locals.user, 'inventory:retract') || hasPermission(locals.user, 'admin:full');

	// SPU-MFG-03: compute per-field lock/focus/admin flags at read time (not persisted).
	const isAdmin = hasPermission(locals.user, 'admin:full') || hasPermission(locals.user, 'spu:write-admin');
	const spuIsFinalized = !!sp?.finalizedAt;

	// Index capturedFieldRecords by stepFieldDefinitionId for O(1) lookup.
	const capturedByFieldDefId = new Map<string, { id: string; fieldValue: string }>();
	for (const rec of capturedFieldRecords) {
		if (rec.stepFieldDefinitionId) {
			capturedByFieldDefId.set(rec.stepFieldDefinitionId, {
				id: rec.id,
				fieldValue: rec.fieldValue
			});
		}
	}

	// Enrich fieldDefinitions with currentValue, captureId, isLocked, editableByAdmin.
	workInstructionSteps = workInstructionSteps.map((step: any) => {
		let priorRequiredUnfilled = false;
		const enrichedFields = step.fieldDefinitions.map((fd: any) => {
			const captured = capturedByFieldDefId.get(fd.id) ?? null;
			const currentValue: string | null = captured ? (captured.fieldValue ?? null) : null;
			const captureId: string | null = captured ? captured.id : null;
			const isLocked = priorRequiredUnfilled;
			const editableByAdmin = currentValue !== null && !spuIsFinalized && isAdmin;
			// Update the "priorRequiredUnfilled" state AFTER this field so it affects subsequent fields.
			if (fd.isRequired && currentValue === null) {
				priorRequiredUnfilled = true;
			}
			return {
				...fd,
				currentValue,
				captureId,
				isLocked,
				editableByAdmin
			};
		});
		return { ...step, fieldDefinitions: enrichedFields };
	});

	// Compute focus coordinates and final-step completion.
	const lastIndex = Math.max(0, workInstructionSteps.length - 1);
	const isStepAllRequiredCaptured = (step: any): boolean => {
		const req = (step.fieldDefinitions ?? []).filter((f: any) => f.isRequired);
		return req.every((f: any) => f.currentValue !== null);
	};
	let focusStepIndex = workInstructionSteps.findIndex((st: any) => !isStepAllRequiredCaptured(st));
	if (focusStepIndex === -1) focusStepIndex = lastIndex;

	const focusStep = workInstructionSteps[focusStepIndex];
	let focusFieldIndex = 0;
	if (focusStep) {
		const idx = (focusStep.fieldDefinitions ?? []).findIndex(
			(f: any) => f.currentValue === null && f.isLocked === false
		);
		focusFieldIndex = idx === -1 ? 0 : idx;
	}

	const isFinalStepComplete = workInstructionSteps.length > 0
		? isStepAllRequiredCaptured(workInstructionSteps[lastIndex])
		: false;

	return {
		session: {
			id: s._id,
			spuId: s.spuId ?? '',
			status: s.status,
			currentStepIndex: s.currentStepIndex ?? 0,
			startedAt: s.startedAt ?? s.createdAt,
			completedAt: s.completedAt ?? null,
			workInstructionId: s.workInstructionId ?? null,
			focusStepIndex,
			focusFieldIndex,
			isFinalStepComplete,
			isAdmin
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
		if (!stepFieldDefinitionId || rawValue === undefined)
			return fail(400, { error: 'Field definition ID and value required' });
		const session = await AssemblySession.findById(params.sessionId);
		if (!session) return fail(404, { error: 'Session not found' });
		const s = session as any;

		// SPU-MFG-04: server-side sequential lock check.
		// Resolve the current WI step: prefer the passed assemblyStepRecordId (== workInstructionStepId),
		// else fall back to the session's currentStepIndex.
		const currentStepIndex: number = s.currentStepIndex ?? 0;
		let currentWiStep: any = null;
		let sortedFieldDefs: any[] = [];
		if (s.workInstructionId) {
			const wi = await WorkInstruction.findById(s.workInstructionId).lean() as any;
			if (wi) {
				const currentVersion = (wi.versions ?? []).find(
					(v: any) => v.version === wi.currentVersion
				) ?? (wi.versions ?? []).slice(-1)[0];
				const wiSteps: any[] = currentVersion?.steps ?? [];
				if (assemblyStepRecordId) {
					currentWiStep = wiSteps.find((st: any) => st._id === assemblyStepRecordId) ?? null;
				}
				if (!currentWiStep) {
					currentWiStep = wiSteps[currentStepIndex] ?? null;
				}
				if (currentWiStep) {
					sortedFieldDefs = (currentWiStep.fieldDefinitions ?? [])
						.slice()
						.sort((a: any, b: any) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
				}
			}
		}

		// Index already-captured field records by stepFieldDefinitionId.
		const capturedByDefId = new Map<string, string>();
		for (const sr of (s.stepRecords ?? [])) {
			for (const fr of (sr.fieldRecords ?? [])) {
				if (fr.stepFieldDefinitionId && fr.fieldValue !== undefined && fr.fieldValue !== null && fr.fieldValue !== '') {
					capturedByDefId.set(fr.stepFieldDefinitionId, fr.fieldValue);
				}
			}
		}

		// Locate the target field within the sorted list.
		const targetFieldIdx = sortedFieldDefs.findIndex((fd: any) => fd._id === stepFieldDefinitionId);
		if (targetFieldIdx !== -1) {
			const targetField = sortedFieldDefs[targetFieldIdx];
			const targetSortOrder = targetField.sortOrder ?? 0;
			// Verify every prior required field has a captured, non-empty value.
			for (const fd of sortedFieldDefs) {
				const fdSortOrder = fd.sortOrder ?? 0;
				if (fdSortOrder >= targetSortOrder) continue;
				if (fd.isRequired) {
					const captured = capturedByDefId.get(fd._id);
					if (!captured) {
						return fail(400, { error: 'Prior required field not captured', code: 'SEQUENTIAL_LOCK' });
					}
				}
			}
		}

		let stepRecord = (s.stepRecords ?? []).find(
			(sr: any) => sr.workInstructionStepId === assemblyStepRecordId
		);
		if (!stepRecord) {
			if (!s.stepRecords) s.stepRecords = [];
			s.stepRecords.push({ _id: generateId(), workInstructionStepId: assemblyStepRecordId ?? '', stepNumber: (s.stepRecords?.length ?? 0) + 1, fieldRecords: [] });
			stepRecord = s.stepRecords[s.stepRecords.length - 1];
		}
		if (!stepRecord.fieldRecords) stepRecord.fieldRecords = [];
		stepRecord.fieldRecords.push({ _id: generateId(), stepFieldDefinitionId, fieldValue: rawValue, rawBarcodeData: isBarcodeScan ? rawValue : null, scannedAt: new Date(), capturedBy: locals.user!._id });
		await session.save();
		await AuditLog.create({
			_id: generateId(),
			tableName: 'assembly_sessions',
			recordId: params.sessionId,
			action: 'UPDATE',
			changedBy: locals.user?.username ?? locals.user?._id,
			changedAt: new Date()
		});

		// SPU-MFG-04: compute next focus coordinates AFTER successful capture.
		// Refresh the captured index with the just-saved value.
		capturedByDefId.set(stepFieldDefinitionId, rawValue);
		let nextFieldIndex = -1;
		let allRequiredOnStepCaptured = true;
		if (sortedFieldDefs.length) {
			for (let i = 0; i < sortedFieldDefs.length; i++) {
				const fd = sortedFieldDefs[i];
				if (fd.isRequired && !capturedByDefId.has(fd._id)) {
					allRequiredOnStepCaptured = false;
					if (nextFieldIndex === -1) nextFieldIndex = i;
				}
			}
		}
		const nextStepIndex = allRequiredOnStepCaptured ? currentStepIndex + 1 : currentStepIndex;

		return { success: true, bomItemLinked: false, nextFieldIndex, nextStepIndex };
	},

	goToStep: async ({ request, locals, params }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const stepIndexRaw = form.get('stepIndex')?.toString();
		if (stepIndexRaw === undefined || stepIndexRaw === '')
			return fail(400, { error: 'stepIndex required' });
		const stepIndex = Number(stepIndexRaw);
		if (!Number.isFinite(stepIndex) || !Number.isInteger(stepIndex) || stepIndex < 0)
			return fail(400, { error: 'stepIndex must be a non-negative integer' });

		const session = await AssemblySession.findById(params.sessionId);
		if (!session) return fail(404, { error: 'Session not found' });
		const s = session as any;
		const fromStepIndex: number = s.currentStepIndex ?? 0;

		// Load the WI steps so we can guard forward skips past incomplete steps.
		let wiSteps: any[] = [];
		if (s.workInstructionId) {
			const wi = await WorkInstruction.findById(s.workInstructionId).lean() as any;
			if (wi) {
				const currentVersion = (wi.versions ?? []).find(
					(v: any) => v.version === wi.currentVersion
				) ?? (wi.versions ?? []).slice(-1)[0];
				wiSteps = currentVersion?.steps ?? [];
			}
		}

		// Forward-skip guard: only enforced when moving forward.
		if (stepIndex > fromStepIndex) {
			const isAdmin = hasPermission(locals.user, 'admin:full');
			if (!isAdmin) {
				// Index already-captured field records by stepFieldDefinitionId.
				const capturedByDefId = new Map<string, string>();
				for (const sr of (s.stepRecords ?? [])) {
					for (const fr of (sr.fieldRecords ?? [])) {
						if (fr.stepFieldDefinitionId && fr.fieldValue !== undefined && fr.fieldValue !== null && fr.fieldValue !== '') {
							capturedByDefId.set(fr.stepFieldDefinitionId, fr.fieldValue);
						}
					}
				}
				// Check every step from fromStepIndex up to (but not including) stepIndex.
				const upperBound = Math.min(stepIndex, wiSteps.length);
				for (let i = fromStepIndex; i < upperBound; i++) {
					const step = wiSteps[i];
					if (!step) continue;
					const fieldDefs: any[] = (step.fieldDefinitions ?? [])
						.slice()
						.sort((a: any, b: any) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
					for (const fd of fieldDefs) {
						if (fd.isRequired && !capturedByDefId.has(fd._id)) {
							return fail(400, { error: 'Cannot skip forward past incomplete step', code: 'FORWARD_SKIP_BLOCKED' });
						}
					}
				}
			}
		}

		s.currentStepIndex = stepIndex;
		await session.save();

		await AuditLog.create({
			_id: generateId(),
			tableName: 'assembly_sessions',
			recordId: params.sessionId,
			action: 'UPDATE',
			changedBy: locals.user?.username ?? locals.user?._id,
			changedAt: new Date()
		});

		return { success: true, currentStepIndex: stepIndex };
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
		const lotNumber = barcode;
		let partDef: any = partDefinitionId ? await PartDefinition.findById(partDefinitionId).lean() : null;
		if (workInstructionStepId) {
			if (!s.stepRecords) s.stepRecords = [];
			const existingRecord = s.stepRecords.find((sr: any) => sr.workInstructionStepId === workInstructionStepId);
			if (!existingRecord) {
				s.stepRecords.push({ _id: generateId(), workInstructionStepId, stepNumber: s.stepRecords.length + 1, scannedLotNumber: lotNumber, scannedPartNumber: partDef?.partNumber ?? '', completedAt: new Date(), completedBy: { _id: locals.user!._id, username: locals.user!.username } });
			}
		} else {
			s.currentStepIndex = (s.currentStepIndex ?? 0) + 1;
		}
		await session.save();
		let inventoryDeduction = null;
		if (s.spuId) {
			await Spu.updateOne({ _id: s.spuId }, { $push: { parts: { _id: generateId(), partDefinitionId: partDefinitionId ?? null, partNumber: partDef?.partNumber ?? '', partName: partDef?.name ?? '', lotNumber, barcodeData: barcode, scannedAt: new Date(), scannedBy: { _id: locals.user!._id, username: locals.user!.username } } } });
			if (partDefinitionId && partDef) {
				const prevQty = (partDef as any).inventoryCount ?? 0;
				const newQty = Math.max(0, prevQty - 1);
				await PartDefinition.updateOne({ _id: partDefinitionId }, { $inc: { inventoryCount: -1 } });
				await InventoryTransaction.create({ _id: generateId(), partDefinitionId, assemblySessionId: params.sessionId, transactionType: 'deduction', quantity: -1, previousQuantity: prevQty, newQuantity: newQty, reason: `Assembly scan for SPU ${s.spuId}`, performedBy: locals.user!.username, performedAt: new Date() });
				inventoryDeduction = { previousQuantity: prevQty, newQuantity: newQty };
			}
		}
		await AuditLog.create({
			_id: generateId(),
			tableName: 'assembly_sessions',
			recordId: params.sessionId,
			action: 'UPDATE',
			changedBy: locals.user?.username ?? locals.user?._id,
			changedAt: new Date()
		});
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
		if (txn.partDefinitionId) await PartDefinition.updateOne({ _id: txn.partDefinitionId }, { $inc: { inventoryCount: Math.abs(txn.quantity) } });
		await InventoryTransaction.updateOne({ _id: transactionId }, { $set: { retractedAt: new Date(), retractedBy: locals.user!.username, retractionReason: reason } });
		await AuditLog.create({
			_id: generateId(),
			tableName: 'assembly_sessions',
			recordId: params.sessionId,
			action: 'UPDATE',
			changedBy: locals.user?.username ?? locals.user?._id,
			changedAt: new Date()
		});
		return { success: true };
	},

	pause: async ({ locals, params }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		await AssemblySession.updateOne({ _id: params.sessionId }, { $set: { status: 'paused', pausedAt: new Date() } });
		await AuditLog.create({
			_id: generateId(),
			tableName: 'assembly_sessions',
			recordId: params.sessionId,
			action: 'UPDATE',
			changedBy: locals.user?.username ?? locals.user?._id,
			changedAt: new Date()
		});
		return { success: true };
	},

	resume: async ({ locals, params }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		await AssemblySession.updateOne({ _id: params.sessionId }, { $set: { status: 'in_progress' }, $unset: { pausedAt: '' } });
		await AuditLog.create({
			_id: generateId(),
			tableName: 'assembly_sessions',
			recordId: params.sessionId,
			action: 'UPDATE',
			changedBy: locals.user?.username ?? locals.user?._id,
			changedAt: new Date()
		});
		return { success: true };
	},

	// SPU-MFG-06: completeBuild — validates every required field on every step,
	// transitions session -> completed, transitions SPU assembling -> assembled,
	// pushes statusTransitions entry, audit-logs both records, returns redirect hint.
	completeBuild: async ({ locals, params }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();

		const session = await AssemblySession.findById(params.sessionId).lean() as any;
		if (!session) return fail(404, { error: 'Session not found' });
		if (session.status === 'completed') {
			return fail(400, { error: 'Session already completed' });
		}

		// Load the WI version steps the same way the load function does.
		let workInstructionSteps: any[] = [];
		if (session.workInstructionId) {
			const wi = await WorkInstruction.findById(session.workInstructionId).lean() as any;
			if (wi) {
				const currentVersion = (wi.versions ?? []).find(
					(v: any) => v.version === wi.currentVersion
				) ?? (wi.versions ?? []).slice(-1)[0];
				workInstructionSteps = (currentVersion?.steps ?? []).map((step: any) => ({
					id: step._id,
					stepNumber: step.stepNumber ?? 0,
					fieldDefinitions: (step.fieldDefinitions ?? [])
						.slice()
						.sort((a: any, b: any) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
						.map((fd: any) => ({
							id: fd._id,
							fieldName: fd.fieldName ?? '',
							isRequired: fd.isRequired ?? false
						}))
				}));
			}
		}

		// Index captured fieldRecords by stepFieldDefinitionId for O(1) lookup.
		const capturedByFieldDefId = new Map<string, string>();
		for (const sr of (session.stepRecords ?? [])) {
			for (const fr of (sr.fieldRecords ?? [])) {
				if (fr.stepFieldDefinitionId && fr.fieldValue !== undefined && fr.fieldValue !== null && fr.fieldValue !== '') {
					capturedByFieldDefId.set(fr.stepFieldDefinitionId, fr.fieldValue);
				}
			}
		}

		// Verify every required field on every step has a captured fieldRecord with non-empty value.
		const missing: { stepNumber: number; fieldName: string }[] = [];
		for (const step of workInstructionSteps) {
			for (const fd of (step.fieldDefinitions ?? [])) {
				if (fd.isRequired && !capturedByFieldDefId.has(fd.id)) {
					missing.push({ stepNumber: step.stepNumber, fieldName: fd.fieldName });
				}
			}
		}
		if (missing.length > 0) {
			return fail(400, { error: 'Missing required fields', code: 'INCOMPLETE_BUILD', missing });
		}

		const now = new Date();
		const operator = { _id: locals.user!._id, username: locals.user!.username };

		// Update the AssemblySession.
		await AssemblySession.updateOne(
			{ _id: params.sessionId },
			{
				$set: {
					status: 'completed',
					completedAt: now,
					completedBy: operator
				}
			}
		);

		// Transition the SPU (if linked).
		if (session.spuId) {
			const spu = await Spu.findById(session.spuId).lean() as any;
			if (spu) {
				const previousStatus = spu.status ?? null;
				// Only forward-transition from 'assembling' -> 'assembled'. Don't regress later states.
				const forwardStates = ['draft', 'assembling'];
				const shouldTransitionStatus = forwardStates.includes(previousStatus);

				const spuSet: any = {
					assemblyStatus: 'completed',
					'assembly.completedAt': now
				};
				const spuUpdate: any = { $set: spuSet };

				if (shouldTransitionStatus) {
					spuSet.status = 'assembled';
					spuUpdate.$push = {
						statusTransitions: {
							_id: generateId(),
							from: previousStatus,
							to: 'assembled',
							changedBy: operator,
							changedAt: now,
							reason: 'Assembly build completed'
						}
					};
				}

				await Spu.updateOne({ _id: session.spuId }, spuUpdate);

				await AuditLog.create({
					_id: generateId(),
					tableName: 'spus',
					recordId: session.spuId,
					action: 'UPDATE',
					changedBy: locals.user?.username ?? locals.user?._id,
					changedAt: now
				});
			}
		}

		await AuditLog.create({
			_id: generateId(),
			tableName: 'assembly_sessions',
			recordId: params.sessionId,
			action: 'UPDATE',
			changedBy: locals.user?.username ?? locals.user?._id,
			changedAt: now
		});

		return {
			success: true,
			spuId: session.spuId,
			redirectTo: '/spu/' + session.spuId + '?fromBuild=1'
		};
	},

	// SPU-MFG-05 — admin-only edit of a previously captured field.
	// Writes an in-place update to AssemblySession.stepRecords[].fieldRecords[],
	// mirrors to SPU.assembly.stepRecords[].fieldRecords[] (pre-finalization only —
	// sacred middleware blocks any update after finalizedAt is set), and always
	// pushes a corrections[] entry on the SPU (using collection.updateOne to
	// bypass sacred middleware when the SPU is finalized — push to corrections[]
	// is the sanctioned post-finalization audit trail per CLAUDE.md).
	editField: async ({ request, locals, params }) => {
		if (
			!hasPermission(locals.user, 'admin:full') &&
			!hasPermission(locals.user, 'spu:write-admin')
		) {
			return fail(403, { error: 'Admin permission required' });
		}
		await connectDB();

		const form = await request.formData();
		const fieldRecordId = form.get('fieldRecordId')?.toString();
		const newValue = form.get('newValue')?.toString();
		const reason = form.get('reason')?.toString()?.trim();

		if (!fieldRecordId) return fail(400, { error: 'fieldRecordId is required' });
		if (newValue === undefined || newValue === null)
			return fail(400, { error: 'newValue is required' });
		if (!reason || reason.length < 3)
			return fail(400, { error: 'reason is required (min 3 characters)' });

		const session = await AssemblySession.findById(params.sessionId);
		if (!session) return fail(404, { error: 'Session not found' });
		const s = session as any;

		// Locate the fieldRecord across all stepRecords.
		let targetStepRecord: any = null;
		let targetFieldRecord: any = null;
		for (const sr of s.stepRecords ?? []) {
			const fr = (sr.fieldRecords ?? []).find((f: any) => f._id === fieldRecordId);
			if (fr) {
				targetStepRecord = sr;
				targetFieldRecord = fr;
				break;
			}
		}
		if (!targetFieldRecord) return fail(404, { error: 'Field record not found' });

		const previousValue = targetFieldRecord.fieldValue;
		const fieldNameForMirror: string = targetFieldRecord.fieldName ?? '';
		const stepNumberForMirror: number = targetStepRecord.stepNumber;

		// Update the fieldRecord in-place on the AssemblySession.
		targetFieldRecord.fieldValue = newValue;
		targetFieldRecord.rawBarcodeData = newValue;
		targetFieldRecord.capturedBy = locals.user!._id;
		await session.save();

		// Mirror to SPU.assembly.stepRecords[].fieldRecords[] by fieldName match within same step number.
		// SPU sacred middleware blocks ALL updateOne/findOneAndUpdate mutations once finalizedAt is set,
		// so we must check finalization first, skip the mirror if finalized, and use a raw collection
		// update for the corrections push.
		const spuId = s.spuId as string | undefined;
		let mirrorSkippedDueToFinalized = false;

		if (spuId) {
			const spu = await Spu.findById(spuId).select('finalizedAt assembly.stepRecords').lean() as any;
			const isFinalized = !!spu?.finalizedAt;

			if (spu && !isFinalized && fieldNameForMirror) {
				// Pre-finalization: update the matching fieldRecord via arrayFilters.
				await Spu.updateOne(
					{ _id: spuId },
					{
						$set: {
							'assembly.stepRecords.$[sr].fieldRecords.$[fr].fieldValue': newValue,
							'assembly.stepRecords.$[sr].fieldRecords.$[fr].rawBarcodeData': newValue
						}
					},
					{
						arrayFilters: [
							{ 'sr.stepNumber': stepNumberForMirror },
							{ 'fr.fieldName': fieldNameForMirror }
						]
					}
				);
			} else if (isFinalized) {
				mirrorSkippedDueToFinalized = true;
			}

			// Always push a corrections entry to the SPU.
			// If finalized, use .collection.updateOne to bypass the sacred middleware
			// (corrections are the sanctioned post-finalization paper trail).
			const correctionEntry = {
				_id: generateId(),
				fieldPath: `assembly.fieldRecord.${fieldRecordId}`,
				previousValue,
				correctedValue: newValue,
				reason,
				correctedBy: { _id: locals.user!._id, username: locals.user!.username },
				correctedAt: new Date()
			};

			if (isFinalized) {
				// Raw collection write bypasses sacred middleware — permitted for
				// the corrections audit trail only. Cast filter because the native
				// driver types expect ObjectId while this codebase uses string IDs.
				await Spu.collection.updateOne(
					{ _id: spuId as any },
					{ $push: { corrections: correctionEntry } as any }
				);
			} else {
				await Spu.updateOne(
					{ _id: spuId },
					{ $push: { corrections: correctionEntry } }
				);
			}

			// AuditLog (immutable).
			await AuditLog.create({
				_id: generateId(),
				tableName: 'spus',
				recordId: spuId,
				action: 'UPDATE',
				oldData: { fieldValue: previousValue },
				newData: { fieldValue: newValue },
				reason,
				changedBy: locals.user?.username ?? locals.user?._id,
				changedAt: new Date()
			});
		} else {
			// No linked SPU — still log against the assembly session.
			await AuditLog.create({
				_id: generateId(),
				tableName: 'assembly_sessions',
				recordId: params.sessionId,
				action: 'UPDATE',
				oldData: { fieldValue: previousValue },
				newData: { fieldValue: newValue },
				reason,
				changedBy: locals.user?.username ?? locals.user?._id,
				changedAt: new Date()
			});
		}

		return { success: true, newValue, mirrorSkippedDueToFinalized };
	}
};

export const config = { maxDuration: 60 };
