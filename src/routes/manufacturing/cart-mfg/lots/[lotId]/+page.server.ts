import { error, redirect, fail } from '@sveltejs/kit';
import { connectDB, LotRecord, ProcessConfiguration, CartridgeRecord } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();

	const lot = await LotRecord.findById(params.lotId).lean() as any;
	if (!lot) throw error(404, 'Lot not found');

	// Cartridges individuated into this backing lot (WAX-FLOW-2): each carries its
	// own scan time + scanner, grouped by backing.parentLotRecordId.
	const carts = await CartridgeRecord.find({ 'backing.parentLotRecordId': params.lotId })
		.select('_id status backing.ovenEntryTime backing.operator backing.ovenLocationName')
		.lean() as any[];
	const cartridges = carts
		.map((c: any) => ({
			barcode: String(c._id),
			status: c.status ?? '',
			scannedAt: c.backing?.ovenEntryTime ? new Date(c.backing.ovenEntryTime).toISOString() : null,
			scannedBy: c.backing?.operator?.username ?? 'unknown',
			oven: c.backing?.ovenLocationName ?? ''
		}))
		.sort((a, b) => (a.scannedAt ?? '').localeCompare(b.scannedAt ?? ''));

	const ovenName = lot.ovenPlacement?.ovenBarcode ?? carts[0]?.backing?.ovenLocationName ?? null;

	return {
		lot: {
			lotId: String(lot._id),
			bucketBarcode: lot.bucketBarcode ?? null,
			outputLotNumber: lot.outputLotNumber ?? null,
			configId: lot.processConfig?.processName ?? lot.processConfig?._id ?? '',
			qrCodeRef: lot.qrCodeRef ?? '',
			quantityProduced: lot.quantityProduced ?? 0,
			status: lot.status ?? null,
			startTime: lot.startTime ? new Date(lot.startTime).toISOString() : null,
			finishTime: lot.finishTime ? new Date(lot.finishTime).toISOString() : null,
			cycleTime: lot.cycleTime ?? null,
			createdAt: lot.createdAt ? new Date(lot.createdAt).toISOString() : '',
			oven: ovenName,
			inputLots: (lot.inputLots ?? []).map((il: any) => ({
				materialName: il.materialName ?? '',
				barcode: il.barcode ?? ''
			}))
		},
		cartridges,
		batchNotes: (lot.stepEntries ?? [])
			.filter((s: any) => s.note || s.imageUrl)
			.map((s: any) => ({
				id: String(s._id),
				note: s.note ?? null,
				imageUrl: s.imageUrl ?? null,
				operatorName: s.operator?.username ?? 'unknown',
				createdAt: s.completedAt ? new Date(s.completedAt).toISOString() : ''
			}))
	};
};

export const actions: Actions = {
	updateLot: async ({ request, params, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
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
		requirePermission(locals.user, 'manufacturing:write');
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
		requirePermission(locals.user, 'manufacturing:write');
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

		redirect(303, `/manufacturing/cart-mfg/lots/${lot._id}`);
	}
};

export const config = { maxDuration: 60 };
