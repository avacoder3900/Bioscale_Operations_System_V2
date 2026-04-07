import { json } from '@sveltejs/kit';
import { connectDB, CartridgeRecord, CvImage, CvInspection, InventoryTransaction, ReceivingLot } from '$lib/server/db';
import { getSignedDownloadUrl } from '$lib/server/r2.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	await connectDB();

	const cartridge = await CartridgeRecord.findById(params.cartridgeId).lean() as any;
	if (!cartridge) return json({ error: 'Cartridge not found' }, { status: 404 });

	// Fetch CV images, inspections, and transactions in parallel
	const [images, inspections, transactions] = await Promise.all([
		CvImage.find({ 'cartridgeTag.cartridgeRecordId': params.cartridgeId })
			.sort({ capturedAt: -1 })
			.lean(),
		CvInspection.find({ cartridgeRecordId: params.cartridgeId })
			.sort({ completedAt: -1 })
			.lean(),
		InventoryTransaction.find({ cartridgeRecordId: params.cartridgeId })
			.sort({ performedAt: 1 })
			.lean()
	]);

	// Generate signed R2 URLs for photos that have r2Key or filePath
	const photos = await Promise.all(
		(images as any[]).map(async (img) => {
			const r2Key = img.filePath || (cartridge.photos || []).find((p: any) => p.imageId === img._id)?.r2Key;
			let url: string | null = null;
			let thumbnailUrl: string | null = null;

			if (r2Key) {
				try { url = await getSignedDownloadUrl(r2Key); } catch { /* no-op */ }
			}
			if (img.thumbnailPath) {
				try { thumbnailUrl = await getSignedDownloadUrl(img.thumbnailPath); } catch { /* no-op */ }
			}
			// Fallback to imageUrl if no R2 key
			if (!url && img.imageUrl) url = img.imageUrl;

			// Find matching inspection for this image
			const inspection = (inspections as any[]).find(i => i.imageId === img._id);

			return {
				imageId: img._id,
				phase: img.cartridgeTag?.phase || null,
				labels: img.cartridgeTag?.labels || [],
				capturedAt: img.capturedAt || img.createdAt,
				url,
				thumbnailUrl,
				label: img.label || null,
				inspectionResult: inspection?.result || null,
				confidenceScore: inspection?.confidenceScore || null
			};
		})
	);

	// Build timeline from cartridge phases
	const timeline: any[] = [];

	// Backing
	if (cartridge.backing) {
		const lotIds: string[] = [];
		if (cartridge.backing.lotId) lotIds.push(cartridge.backing.lotId);
		const stepPhotos = photos.filter(p => p.phase === 'backing');
		timeline.push({
			step: 'backing',
			timestamp: cartridge.backing.recordedAt?.toISOString?.() ?? cartridge.backing.ovenEntryTime?.toISOString?.() ?? null,
			operator: null,
			details: {
				lotId: cartridge.backing.lotId ?? null,
				lotQrCode: cartridge.backing.lotQrCode ?? null,
				ovenEntryTime: cartridge.backing.ovenEntryTime ?? null
			},
			lotIds,
			photos: stepPhotos
		});
	}

	// Wax filling
	if (cartridge.waxFilling?.recordedAt) {
		const lotIds: string[] = [];
		if (cartridge.waxFilling.waxSourceLot) lotIds.push(cartridge.waxFilling.waxSourceLot);
		const stepPhotos = photos.filter(p => p.phase === 'wax_filling' || p.phase === 'wax-filling');
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
			lotIds,
			photos: stepPhotos
		});
	}

	// Wax QC
	if (cartridge.waxQc?.recordedAt) {
		const stepPhotos = photos.filter(p => p.phase === 'wax_qc' || p.phase === 'wax-qc');
		timeline.push({
			step: 'wax_qc',
			timestamp: cartridge.waxQc.timestamp?.toISOString?.() ?? null,
			operator: cartridge.waxQc.operator ?? null,
			details: {
				status: cartridge.waxQc.status ?? null,
				rejectionReason: cartridge.waxQc.rejectionReason ?? null
			},
			lotIds: [],
			photos: stepPhotos
		});
	}

	// Wax storage
	if (cartridge.waxStorage?.recordedAt) {
		const stepPhotos = photos.filter(p => p.phase === 'wax_storage' || p.phase === 'wax-storage');
		timeline.push({
			step: 'wax_storage',
			timestamp: cartridge.waxStorage.timestamp?.toISOString?.() ?? null,
			operator: cartridge.waxStorage.operator ?? null,
			details: {
				location: cartridge.waxStorage.location ?? null,
				coolingTrayId: cartridge.waxStorage.coolingTrayId ?? null
			},
			lotIds: [],
			photos: stepPhotos
		});
	}

	// Reagent filling
	if (cartridge.reagentFilling?.recordedAt) {
		const stepPhotos = photos.filter(p => p.phase === 'reagent_filling' || p.phase === 'reagent-filling');
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
			lotIds: [],
			photos: stepPhotos
		});
	}

	// Reagent inspection
	if (cartridge.reagentInspection?.recordedAt) {
		const stepPhotos = photos.filter(p => p.phase === 'reagent_inspection' || p.phase === 'reagent-inspection');
		timeline.push({
			step: 'reagent_inspection',
			timestamp: cartridge.reagentInspection.timestamp?.toISOString?.() ?? null,
			operator: cartridge.reagentInspection.operator ?? null,
			details: {
				status: cartridge.reagentInspection.status ?? null,
				reason: cartridge.reagentInspection.reason ?? null
			},
			lotIds: [],
			photos: stepPhotos
		});
	}

	// Top seal
	if (cartridge.topSeal?.recordedAt) {
		const lotIds: string[] = [];
		if (cartridge.topSeal.topSealLotId) lotIds.push(cartridge.topSeal.topSealLotId);
		const stepPhotos = photos.filter(p => p.phase === 'top_seal' || p.phase === 'top-seal');
		timeline.push({
			step: 'top_seal',
			timestamp: cartridge.topSeal.timestamp?.toISOString?.() ?? null,
			operator: cartridge.topSeal.operator ?? null,
			details: {
				batchId: cartridge.topSeal.batchId ?? null,
				topSealLotId: cartridge.topSeal.topSealLotId ?? null
			},
			lotIds,
			photos: stepPhotos
		});
	}

	// Oven cure
	if (cartridge.ovenCure?.recordedAt) {
		const stepPhotos = photos.filter(p => p.phase === 'oven_cure' || p.phase === 'oven-cure');
		timeline.push({
			step: 'oven_cure',
			timestamp: cartridge.ovenCure.entryTime?.toISOString?.() ?? null,
			operator: null,
			details: {
				locationName: cartridge.ovenCure.locationName ?? null
			},
			lotIds: [],
			photos: stepPhotos
		});
	}

	// Storage
	if (cartridge.storage?.recordedAt) {
		const stepPhotos = photos.filter(p => p.phase === 'storage');
		timeline.push({
			step: 'storage',
			timestamp: cartridge.storage.timestamp?.toISOString?.() ?? null,
			operator: cartridge.storage.operator ?? null,
			details: {
				fridgeId: cartridge.storage.fridgeId ?? null,
				fridgeName: cartridge.storage.fridgeName ?? null,
				containerBarcode: cartridge.storage.containerBarcode ?? null
			},
			lotIds: [],
			photos: stepPhotos
		});
	}

	// QA/QC release
	if (cartridge.qaqcRelease?.recordedAt) {
		const stepPhotos = photos.filter(p => p.phase === 'qa_qc' || p.phase === 'qa-qc');
		timeline.push({
			step: 'qa_qc',
			timestamp: cartridge.qaqcRelease.testedAt?.toISOString?.() ?? null,
			operator: cartridge.qaqcRelease.testedBy ?? null,
			details: {
				shippingLotId: cartridge.qaqcRelease.shippingLotId ?? null,
				testResult: cartridge.qaqcRelease.testResult ?? null,
				notes: cartridge.qaqcRelease.notes ?? null
			},
			lotIds: [],
			photos: stepPhotos
		});
	}

	// Shipping
	if (cartridge.shipping?.recordedAt) {
		const stepPhotos = photos.filter(p => p.phase === 'shipping');
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
			lotIds: [],
			photos: stepPhotos
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
		cartridge: JSON.parse(JSON.stringify({
			cartridgeId: cartridge._id,
			status: cartridge.status ?? 'unknown',
			voidedAt: cartridge.voidedAt ?? null,
			voidReason: cartridge.voidReason ?? null,
			createdAt: cartridge.createdAt,
			updatedAt: cartridge.updatedAt,
			photos: cartridge.photos || []
		})),
		timeline: JSON.parse(JSON.stringify(timeline)),
		photos: JSON.parse(JSON.stringify(photos)),
		inspections: JSON.parse(JSON.stringify(
			(inspections as any[]).map(i => ({
				inspectionId: i._id,
				phase: i.phase,
				result: i.result,
				confidenceScore: i.confidenceScore,
				defects: i.defects || [],
				completedAt: i.completedAt
			}))
		)),
		transactions: JSON.parse(JSON.stringify(transactions)),
		linkedLots: JSON.parse(JSON.stringify(linkedLots))
	});
};
