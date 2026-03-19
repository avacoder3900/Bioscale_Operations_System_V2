import { error, redirect, fail } from '@sveltejs/kit';
import { connectDB, LotRecord, ProcessConfiguration } from '$lib/server/db';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	if (!locals.user) redirect(302, '/login');
	await connectDB();

	const lot = await LotRecord.findById(params.lotId).lean() as any;
	if (!lot) throw error(404, 'Lot not found');

	return {
		lot: {
			id: lot._id,
			qrCodeRef: lot.qrCodeRef,
			processConfig: lot.processConfig ?? null,
			operator: lot.operator ?? null,
			inputLots: lot.inputLots ?? null,
			quantityProduced: lot.quantityProduced ?? null,
			desiredQuantity: lot.desiredQuantity ?? null,
			quantityDiscrepancyReason: lot.quantityDiscrepancyReason ?? null,
			startTime: lot.startTime ?? null,
			finishTime: lot.finishTime ?? null,
			cycleTime: lot.cycleTime ?? null,
			ovenEntryTime: lot.ovenEntryTime ?? null,
			wiRevision: lot.wiRevision ?? null,
			status: lot.status ?? null,
			cartridgeIds: lot.cartridgeIds ?? [],
			createdAt: lot.createdAt,
			updatedAt: lot.updatedAt
		},
		steps: (lot.stepEntries ?? []).map((s: any) => ({
			id: s._id,
			stepId: s.stepId ?? null,
			stepNumber: s.stepNumber ?? null,
			stepTitle: s.stepTitle ?? null,
			note: s.note ?? null,
			imageUrl: s.imageUrl ?? null,
			operator: s.operator ?? null,
			completedAt: s.completedAt ?? null
		}))
	};
};

export const actions: Actions = {
	updateLot: async ({ request, params, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const update: Record<string, any> = {};

		const status = data.get('status');
		if (status) update.status = status;
		const quantityProduced = data.get('quantityProduced');
		if (quantityProduced) update.quantityProduced = Number(quantityProduced);
		const desiredQuantity = data.get('desiredQuantity');
		if (desiredQuantity) update.desiredQuantity = Number(desiredQuantity);
		const quantityDiscrepancyReason = data.get('quantityDiscrepancyReason');
		if (quantityDiscrepancyReason) update.quantityDiscrepancyReason = quantityDiscrepancyReason;
		const finishTime = data.get('finishTime');
		if (finishTime) update.finishTime = new Date(finishTime as string);

		await LotRecord.findByIdAndUpdate(params.lotId, { $set: update });
		return { success: true };
	},

	addStep: async ({ request, params, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const stepEntry = {
			stepId: data.get('stepId') as string,
			stepNumber: Number(data.get('stepNumber')),
			stepTitle: data.get('stepTitle') as string,
			note: (data.get('note') as string) || undefined,
			imageUrl: (data.get('imageUrl') as string) || undefined,
			operator: { _id: locals.user._id, username: locals.user.username },
			completedAt: new Date()
		};

		await LotRecord.findByIdAndUpdate(params.lotId, {
			$push: { stepEntries: stepEntry }
		});
		return { success: true };
	},

	createLot: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const configId = data.get('processConfigId') as string;
		let processConfig = null;

		if (configId) {
			const config = await ProcessConfiguration.findById(configId).lean() as any;
			if (config) {
				processConfig = { _id: config._id, processName: config.processName, processType: config.processType };
			}
		}

		const lot = await LotRecord.create({
			qrCodeRef: data.get('qrCodeRef') as string,
			processConfig,
			operator: { _id: locals.user._id, username: locals.user.username },
			desiredQuantity: Number(data.get('desiredQuantity') || 0),
			status: 'in_progress',
			startTime: new Date(),
			stepEntries: []
		});

		redirect(303, `/manufacturing/lots/${lot._id}`);
	}
};

export const config = { maxDuration: 60 };
