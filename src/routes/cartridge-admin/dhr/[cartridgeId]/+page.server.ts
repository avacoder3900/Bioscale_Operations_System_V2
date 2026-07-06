import { error } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, CartridgeRecord, CvInspection, InventoryTransaction, ReceivingLot, ManufacturingSettings } from '$lib/server/db';
import { getR2Url } from '$lib/server/services/r2';
import { getCartridgeTimings } from '$lib/utils/cartridge-timings';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	requirePermission(locals.user, 'cartridgeAdmin:read');
	await connectDB();

	const cartridge = await CartridgeRecord.findById(params.cartridgeId).lean() as any;
	if (!cartridge) throw error(404, 'Cartridge not found');

	// Parallel queries. Photos come from cartridge.photos[] (already loaded above);
	// only machine verdicts + transactions + settings need their own reads.
	const [inspections, transactions, settingsDoc] = await Promise.all([
		CvInspection.find({ cartridgeRecordId: params.cartridgeId })
			.sort({ completedAt: -1 })
			.lean(),
		InventoryTransaction.find({ cartridgeRecordId: params.cartridgeId })
			.sort({ performedAt: 1 })
			.lean(),
		ManufacturingSettings.findById('default').lean()
	]);

	// Informational-only timing metrics (cool time for wax, seal time for
	// reagent). Pure derived — no writes, no gates.
	const settings = settingsDoc as any;
	const timings = getCartridgeTimings(cartridge, {
		coolMin: settings?.waxFilling?.coolingWarningMin,
		sealMin: settings?.reagentFilling?.maxTimeBeforeSealMin
	});

	// Photos come straight from the cartridge record of truth. R2 pointers live
	// on each entry (r2Url already worker-routed → getR2Url(r2Key) fallback).
	const photos = ([...(cartridge.photos || [])] as any[])
		.sort((a, b) => new Date(a.capturedAt || 0).getTime() - new Date(b.capturedAt || 0).getTime())
		.map((p) => {
			const url = p.r2Url || (p.r2Key ? getR2Url(p.r2Key) : null);
			const inspection = (inspections as any[]).find(i => i.imageId === p.imageId);

			return {
				imageId: p.imageId,
				cartridgeImageNumber: p.cartridgeImageNumber ?? null,
				cartridgeRecordId: params.cartridgeId,
				phase: p.phase || 'untagged',
				labels: p.labels || [],
				notes: p.notes || '',
				// Human QC verdict — the pass/fail shown in the image stream (approved/rejected/null).
				qcLabel: p.qcLabel ?? null,
				capturedAt: p.capturedAt || null,
				capturedByUsername: p.capturedBy?.username ?? null,
				url,
				thumbnailUrl: url,
				// Auto-classifier verdict, separate from the human qcLabel above.
				inspectionResult: inspection?.result || null,
				inspectionStatus: inspection?.status || null,
				confidenceScore: inspection?.confidenceScore ?? null,
				defects: [],
				processingTimeMs: inspection?.processingTimeMs ?? null
			};
		});

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

	// Operator-entered notes attached to this cartridge (mirrored from the
	// run-level note write). Append-only; sorted oldest first.
	const cartridgeNotes = (cartridge.notes ?? [])
		.slice()
		.sort((a: any, b: any) => {
			const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
			const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
			return ta - tb;
		})
		.map((n: any) => ({
			id: n._id,
			body: n.body ?? '',
			phase: n.phase ?? '',
			author: n.author?.username ?? null,
			createdAt: n.createdAt ? new Date(n.createdAt).toISOString() : null
		}));

	return {
		cartridge: JSON.parse(JSON.stringify({
			cartridgeId: cartridge._id,
			status: cartridge.status ?? 'unknown',
			voidedAt: cartridge.voidedAt ?? null,
			voidReason: cartridge.voidReason ?? null,
			createdAt: cartridge.createdAt,
			updatedAt: cartridge.updatedAt
		})),
		notes: cartridgeNotes,
		timeline: JSON.parse(JSON.stringify(timeline)),
		photos: JSON.parse(JSON.stringify(photos)),
		inspections: JSON.parse(JSON.stringify(
			(inspections as any[]).map(i => ({
				inspectionId: i._id,
				imageId: i.imageId,
				phase: i.phase,
				result: i.result,
				confidenceScore: i.confidenceScore,
				completedAt: i.completedAt
			}))
		)),
		transactions: JSON.parse(JSON.stringify(transactions)),
		linkedLots: JSON.parse(JSON.stringify(linkedLots)),
		timings: JSON.parse(JSON.stringify(timings))
	};
};

export const config = { maxDuration: 60 };
