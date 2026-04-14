import { error } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, CartridgeRecord, CvImage, CvInspection, InventoryTransaction, ReceivingLot } from '$lib/server/db';
import { getSignedDownloadUrl } from '$lib/server/r2.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	requirePermission(locals.user, 'cartridgeAdmin:read');
	await connectDB();

	const cartridge = await CartridgeRecord.findById(params.cartridgeId).lean() as any;
	if (!cartridge) throw error(404, 'Cartridge not found');

	// Parallel queries
	const [images, inspections, transactions] = await Promise.all([
		CvImage.find({ 'cartridgeTag.cartridgeRecordId': params.cartridgeId })
			.sort({ capturedAt: 1 })
			.lean(),
		CvInspection.find({ cartridgeRecordId: params.cartridgeId })
			.sort({ completedAt: -1 })
			.lean(),
		InventoryTransaction.find({ cartridgeRecordId: params.cartridgeId })
			.sort({ performedAt: 1 })
			.lean()
	]);

	// Generate signed R2 URLs for each image
	const photos = await Promise.all(
		(images as any[]).map(async (img) => {
			let url: string | null = null;
			let thumbnailUrl: string | null = null;

			// Prioritize imageUrl (already public) over R2 signed URLs
			if (img.imageUrl) {
				url = img.imageUrl;
			}

			// Try to get signed URLs for private R2 paths if available
			const r2Key = img.filePath || (cartridge.photos || []).find((p: any) => p.imageId === img._id)?.r2Key;
			if (r2Key && !url) {
				try { url = await getSignedDownloadUrl(r2Key); } catch { /* no-op */ }
			}
			if (img.thumbnailPath) {
				try { thumbnailUrl = await getSignedDownloadUrl(img.thumbnailPath); } catch { /* no-op */ }
			}
			// Fall back to imageUrl for thumbnail if R2 signing failed
			if (!thumbnailUrl && url) thumbnailUrl = url;

			const inspection = (inspections as any[]).find(i => i.imageId === img._id);

			return {
				imageId: img._id,
				phase: img.cartridgeTag?.phase || 'untagged',
				labels: img.cartridgeTag?.labels || [],
				notes: img.cartridgeTag?.notes || '',
				capturedAt: img.capturedAt || img.createdAt,
				url,
				thumbnailUrl,
				label: img.label || null,
				inspectionResult: inspection?.result || null,
				inspectionStatus: inspection?.status || null,
				confidenceScore: inspection?.confidenceScore ?? null,
				defects: inspection?.defects || [],
				processingTimeMs: inspection?.processingTimeMs ?? null
			};
		})
	);

	// Build timeline phases
	const timeline: any[] = [];

	const addPhase = (step: string, field: any, extraDetails?: Record<string, any>) => {
		if (!field) return;
		const hasTimestamp = field.recordedAt || field.timestamp || field.entryTime || field.shippedAt || field.testedAt || field.fillDate;
		if (!hasTimestamp) return;

		const stepPhotos = photos.filter(p => p.phase === step || p.phase === step.replace(/_/g, '-'));

		timeline.push({
			step,
			timestamp: (field.recordedAt || field.timestamp || field.entryTime || field.shippedAt || field.testedAt || field.fillDate)?.toISOString?.() ?? null,
			operator: field.operator?.username || field.testedBy?.username || null,
			photos: stepPhotos,
			...extraDetails
		});
	};

	addPhase('backing', cartridge.backing, {
		lotId: cartridge.backing?.lotId,
		lotQrCode: cartridge.backing?.lotQrCode
	});
	addPhase('wax_filling', cartridge.waxFilling, {
		runId: cartridge.waxFilling?.runId,
		robotName: cartridge.waxFilling?.robotName,
		waxSourceLot: cartridge.waxFilling?.waxSourceLot
	});
	addPhase('wax_qc', cartridge.waxQc, {
		qcStatus: cartridge.waxQc?.status,
		rejectionReason: cartridge.waxQc?.rejectionReason
	});
	addPhase('wax_storage', cartridge.waxStorage, {
		coolingTrayId: cartridge.waxStorage?.coolingTrayId
	});
	addPhase('reagent_filling', cartridge.reagentFilling, {
		runId: cartridge.reagentFilling?.runId,
		assayType: cartridge.reagentFilling?.assayType?.name,
		expirationDate: cartridge.reagentFilling?.expirationDate?.toISOString?.() ?? null
	});
	addPhase('reagent_inspection', cartridge.reagentInspection, {
		qcStatus: cartridge.reagentInspection?.status
	});
	addPhase('top_seal', cartridge.topSeal, {
		batchId: cartridge.topSeal?.batchId,
		topSealLotId: cartridge.topSeal?.topSealLotId
	});
	addPhase('oven_cure', cartridge.ovenCure, {
		locationName: cartridge.ovenCure?.locationName
	});
	addPhase('storage', cartridge.storage, {
		fridgeName: cartridge.storage?.fridgeName,
		containerBarcode: cartridge.storage?.containerBarcode
	});
	addPhase('qa_qc', cartridge.qaqcRelease, {
		testResult: cartridge.qaqcRelease?.testResult,
		shippingLotId: cartridge.qaqcRelease?.shippingLotId,
		notes: cartridge.qaqcRelease?.notes
	});
	addPhase('shipping', cartridge.shipping, {
		trackingNumber: cartridge.shipping?.trackingNumber,
		carrier: cartridge.shipping?.carrier,
		customer: cartridge.shipping?.customer?.name
	});

	// Linked lots
	const allLotIds = [...new Set([
		cartridge.backing?.lotId,
		cartridge.waxFilling?.waxSourceLot,
		cartridge.topSeal?.topSealLotId,
		cartridge.qaqcRelease?.shippingLotId
	].filter(Boolean))];

	const linkedLots = allLotIds.length > 0
		? await ReceivingLot.find({ $or: [{ _id: { $in: allLotIds } }, { lotId: { $in: allLotIds } }] })
			.select('_id lotId lotNumber part quantity status')
			.lean()
		: [];

	return {
		cartridge: JSON.parse(JSON.stringify({
			cartridgeId: cartridge._id,
			status: cartridge.status ?? 'unknown',
			voidedAt: cartridge.voidedAt ?? null,
			voidReason: cartridge.voidReason ?? null,
			createdAt: cartridge.createdAt,
			updatedAt: cartridge.updatedAt
		})),
		timeline: JSON.parse(JSON.stringify(timeline)),
		photos: JSON.parse(JSON.stringify(photos)),
		inspections: JSON.parse(JSON.stringify(
			(inspections as any[]).map(i => ({
				inspectionId: i._id,
				imageId: i.imageId,
				phase: i.phase,
				result: i.result,
				confidenceScore: i.confidenceScore,
				defects: i.defects || [],
				completedAt: i.completedAt
			}))
		)),
		transactions: JSON.parse(JSON.stringify(transactions)),
		linkedLots: JSON.parse(JSON.stringify(linkedLots))
	};
};

export const config = { maxDuration: 60 };
