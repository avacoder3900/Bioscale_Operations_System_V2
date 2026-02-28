import { fail, error } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import {
	connectDB, AssemblySession, Spu, InventoryTransaction, generateId
} from '$lib/server/db';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	const session = await AssemblySession.findById(params.sessionId).lean();
	if (!session) throw error(404, 'Assembly session not found');
	const s = session as any;

	const spu = s.spuId ? await Spu.findById(s.spuId).lean() : null;

	return {
		session: {
			id: s._id,
			spuId: s.spuId ?? '',
			spuUdi: (spu as any)?.udi ?? '',
			status: s.status,
			currentStepIndex: s.currentStepIndex ?? 0,
			startedAt: s.startedAt ?? s.createdAt,
			completedAt: s.completedAt ?? null,
			workInstructionId: s.workInstructionId ?? null,
			workInstructionTitle: s.workInstructionTitle ?? '',
			stepRecords: (s.stepRecords ?? []).map((sr: any) => ({
				id: sr._id,
				stepNumber: sr.stepNumber,
				stepTitle: sr.stepTitle ?? '',
				completedAt: sr.completedAt ?? null,
				fieldRecords: (sr.fieldRecords ?? []).map((fr: any) => ({
					id: fr._id,
					fieldName: fr.fieldName ?? '',
					fieldLabel: fr.fieldLabel ?? '',
					fieldValue: fr.fieldValue ?? '',
					rawBarcodeData: fr.rawBarcodeData ?? null,
					capturedAt: fr.capturedAt ?? fr.enteredAt ?? null
				}))
			}))
		}
	};
};

export const actions: Actions = {
	captureField: async ({ request, locals, params }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const stepIndex = Number(form.get('stepIndex'));
		const fieldName = form.get('fieldName')?.toString();
		const fieldValue = form.get('fieldValue')?.toString();
		const rawBarcodeData = form.get('rawBarcodeData')?.toString() || undefined;

		if (isNaN(stepIndex) || !fieldName) return fail(400, { error: 'Step index and field name required' });

		const session = await AssemblySession.findById(params.sessionId);
		if (!session) return fail(404, { error: 'Session not found' });
		const s = session as any;

		// Ensure step record exists
		while ((s.stepRecords?.length ?? 0) <= stepIndex) {
			s.stepRecords.push({
				_id: generateId(),
				stepNumber: s.stepRecords.length + 1,
				stepTitle: '',
				fieldRecords: []
			});
		}

		s.stepRecords[stepIndex].fieldRecords.push({
			_id: generateId(),
			fieldName,
			fieldLabel: form.get('fieldLabel')?.toString() || fieldName,
			fieldValue: fieldValue ?? '',
			rawBarcodeData,
			capturedAt: new Date(),
			capturedBy: locals.user!._id,
			bomItemId: form.get('bomItemId')?.toString() || undefined
		});

		await session.save();
		return { success: true };
	},

	completeStep: async ({ request, locals, params }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const stepIndex = Number(form.get('stepIndex'));

		const session = await AssemblySession.findById(params.sessionId);
		if (!session) return fail(404, { error: 'Session not found' });
		const s = session as any;

		if (s.stepRecords?.[stepIndex]) {
			s.stepRecords[stepIndex].completedAt = new Date();
			s.stepRecords[stepIndex].completedBy = {
				_id: locals.user!._id,
				username: locals.user!.username
			};
		}
		s.currentStepIndex = stepIndex + 1;
		await session.save();
		return { success: true };
	},

	scanPart: async ({ request, locals, params }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const barcodeData = form.get('barcodeData')?.toString();
		const partDefinitionId = form.get('partDefinitionId')?.toString();
		const lotNumber = form.get('lotNumber')?.toString();

		if (!barcodeData) return fail(400, { error: 'Barcode data required' });

		// Add part to SPU
		const session = await AssemblySession.findById(params.sessionId);
		if (!session) return fail(404, { error: 'Session not found' });

		if ((session as any).spuId) {
			await Spu.updateOne({ _id: (session as any).spuId }, {
				$push: {
					parts: {
						_id: generateId(),
						partDefinitionId,
						partNumber: form.get('partNumber')?.toString() || '',
						partName: form.get('partName')?.toString() || '',
						lotNumber,
						barcodeData,
						scannedAt: new Date(),
						scannedBy: { _id: locals.user!._id, username: locals.user!.username }
					}
				}
			});

			// Create inventory deduction
			if (partDefinitionId) {
				await InventoryTransaction.create({
					_id: generateId(),
					partDefinitionId,
					assemblySessionId: params.sessionId,
					transactionType: 'deduction',
					quantity: -1,
					reason: `Assembly scan for SPU ${(session as any).spuId}`,
					performedBy: locals.user!.username,
					performedAt: new Date()
				});
			}
		}

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
