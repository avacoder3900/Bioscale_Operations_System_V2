import { json } from '@sveltejs/kit';
import { connectDB, CartridgeRecord, InventoryTransaction, ReceivingLot } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	await connectDB();

	const cartridge = await CartridgeRecord.findById(params.cartridgeId).lean() as any;
	if (!cartridge) return json({ error: 'Cartridge not found' }, { status: 404 });

	// Fetch all inventory transactions for this cartridge
	const transactions = await InventoryTransaction.find({ cartridgeRecordId: params.cartridgeId })
		.sort({ performedAt: 1 })
		.lean();

	// Build timeline from cartridge phases
	const timeline: {
		step: string;
		timestamp: string | null;
		operator: { _id: string; username: string } | null;
		details: Record<string, any>;
		lotIds: string[];
	}[] = [];

	// Backing
	if (cartridge.backing) {
		const lotIds: string[] = [];
		if (cartridge.backing.lotId) lotIds.push(cartridge.backing.lotId);
		timeline.push({
			step: 'backing',
			timestamp: cartridge.backing.recordedAt?.toISOString?.() ?? cartridge.backing.ovenEntryTime?.toISOString?.() ?? null,
			operator: null,
			details: {
				lotId: cartridge.backing.lotId ?? null,
				lotQrCode: cartridge.backing.lotQrCode ?? null,
				ovenEntryTime: cartridge.backing.ovenEntryTime ?? null
			},
			lotIds
		});
	}

	// Wax filling
	if (cartridge.waxFilling?.recordedAt) {
		const lotIds: string[] = [];
		if (cartridge.waxFilling.waxSourceLot) lotIds.push(cartridge.waxFilling.waxSourceLot);
		timeline.push({
			step: 'wax_filling',
			timestamp: cartridge.waxFilling.recordedAt?.toISOString?.() ?? null,
			operator: cartridge.waxFilling.operator ?? null,
			details: {
				runId: cartridge.waxFilling.runId ?? null,
				robotName: cartridge.waxFilling.robotName ?? null,
				deckId: cartridge.waxFilling.deckId ?? null,
				deckPosition: cartridge.waxFilling.deckPosition ?? null,
				waxTubeId: cartridge.waxFilling.waxTubeId ?? null,
				waxSourceLot: cartridge.waxFilling.waxSourceLot ?? null,
				runStartTime: cartridge.waxFilling.runStartTime ?? null,
				runEndTime: cartridge.waxFilling.runEndTime ?? null,
				transferTimeSeconds: cartridge.waxFilling.transferTimeSeconds ?? null
			},
			lotIds
		});
	}

	// Wax QC
	if (cartridge.waxQc?.recordedAt) {
		timeline.push({
			step: 'wax_qc',
			timestamp: cartridge.waxQc.timestamp?.toISOString?.() ?? null,
			operator: cartridge.waxQc.operator ?? null,
			details: {
				status: cartridge.waxQc.status ?? null,
				rejectionReason: cartridge.waxQc.rejectionReason ?? null
			},
			lotIds: []
		});
	}

	// Wax storage
	if (cartridge.waxStorage?.recordedAt) {
		timeline.push({
			step: 'wax_storage',
			timestamp: cartridge.waxStorage.timestamp?.toISOString?.() ?? null,
			operator: cartridge.waxStorage.operator ?? null,
			details: {
				location: cartridge.waxStorage.location ?? null,
				coolingTrayId: cartridge.waxStorage.coolingTrayId ?? null
			},
			lotIds: []
		});
	}

	// Reagent filling
	if (cartridge.reagentFilling?.recordedAt) {
		timeline.push({
			step: 'reagent_filling',
			timestamp: cartridge.reagentFilling.fillDate?.toISOString?.() ?? cartridge.reagentFilling.recordedAt?.toISOString?.() ?? null,
			operator: cartridge.reagentFilling.operator ?? null,
			details: {
				runId: cartridge.reagentFilling.runId ?? null,
				robotName: cartridge.reagentFilling.robotName ?? null,
				assayType: cartridge.reagentFilling.assayType ?? null,
				deckPosition: cartridge.reagentFilling.deckPosition ?? null,
				tubeRecords: cartridge.reagentFilling.tubeRecords ?? [],
				expirationDate: cartridge.reagentFilling.expirationDate ?? null
			},
			lotIds: []
		});
	}

	// Reagent inspection
	if (cartridge.reagentInspection?.recordedAt) {
		timeline.push({
			step: 'reagent_inspection',
			timestamp: cartridge.reagentInspection.timestamp?.toISOString?.() ?? null,
			operator: cartridge.reagentInspection.operator ?? null,
			details: {
				status: cartridge.reagentInspection.status ?? null,
				reason: cartridge.reagentInspection.reason ?? null
			},
			lotIds: []
		});
	}

	// Top seal
	if (cartridge.topSeal?.recordedAt) {
		const lotIds: string[] = [];
		if (cartridge.topSeal.topSealLotId) lotIds.push(cartridge.topSeal.topSealLotId);
		timeline.push({
			step: 'top_seal',
			timestamp: cartridge.topSeal.timestamp?.toISOString?.() ?? null,
			operator: cartridge.topSeal.operator ?? null,
			details: {
				batchId: cartridge.topSeal.batchId ?? null,
				topSealLotId: cartridge.topSeal.topSealLotId ?? null
			},
			lotIds
		});
	}

	// Oven cure
	if (cartridge.ovenCure?.recordedAt) {
		timeline.push({
			step: 'oven_cure',
			timestamp: cartridge.ovenCure.entryTime?.toISOString?.() ?? null,
			operator: null,
			details: {
				locationName: cartridge.ovenCure.locationName ?? null
			},
			lotIds: []
		});
	}

	// Storage
	if (cartridge.storage?.recordedAt) {
		timeline.push({
			step: 'storage',
			timestamp: cartridge.storage.timestamp?.toISOString?.() ?? null,
			operator: cartridge.storage.operator ?? null,
			details: {
				fridgeId: cartridge.storage.fridgeId ?? null,
				fridgeName: cartridge.storage.fridgeName ?? null,
				containerBarcode: cartridge.storage.containerBarcode ?? null
			},
			lotIds: []
		});
	}

	// QA/QC release
	if (cartridge.qaqcRelease?.recordedAt) {
		timeline.push({
			step: 'qa_qc',
			timestamp: cartridge.qaqcRelease.testedAt?.toISOString?.() ?? null,
			operator: cartridge.qaqcRelease.testedBy ?? null,
			details: {
				shippingLotId: cartridge.qaqcRelease.shippingLotId ?? null,
				testResult: cartridge.qaqcRelease.testResult ?? null,
				notes: cartridge.qaqcRelease.notes ?? null
			},
			lotIds: []
		});
	}

	// Shipping
	if (cartridge.shipping?.recordedAt) {
		timeline.push({
			step: 'shipping',
			timestamp: cartridge.shipping.shippedAt?.toISOString?.() ?? null,
			operator: null,
			details: {
				packageBarcode: cartridge.shipping.packageBarcode ?? null,
				customer: cartridge.shipping.customer?.name ?? null,
				trackingNumber: cartridge.shipping.trackingNumber ?? null,
				carrier: cartridge.shipping.carrier ?? null
			},
			lotIds: []
		});
	}

	// Collect all unique lotIds from timeline
	const allLotIds = [...new Set(timeline.flatMap(t => t.lotIds).filter(Boolean))];

	// Fetch receiving lot details for linked lots
	const linkedLots = allLotIds.length > 0
		? await ReceivingLot.find({ $or: [{ _id: { $in: allLotIds } }, { lotId: { $in: allLotIds } }] })
			.select('_id lotId lotNumber part quantity status dispositionType cocDocumentUrl inspectionPathway')
			.lean()
		: [];

	return json({
		success: true,
		cartridge: {
			cartridgeId: cartridge._id,
			currentPhase: cartridge.currentPhase ?? 'unknown',
			voidedAt: cartridge.voidedAt ?? null,
			voidReason: cartridge.voidReason ?? null,
			createdAt: cartridge.createdAt,
			updatedAt: cartridge.updatedAt
		},
		timeline: JSON.parse(JSON.stringify(timeline)),
		transactions: JSON.parse(JSON.stringify(transactions)),
		linkedLots: JSON.parse(JSON.stringify(linkedLots))
	});
};
