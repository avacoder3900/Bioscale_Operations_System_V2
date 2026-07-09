/**
 * POST /api/cv/capture-ingest
 *
 * Agent-keyed multipart upload from the Python capture scripts
 * (camera_capture.py and camera_capture_NO_POST_PROCESSING.py).
 *
 * Backwards-compatible contract for the old lab scripts:
 *  - Still accepts the same multipart fields they send today
 *  - `projectId` is silently ignored (refactor moved CvImage off projects)
 *  - `qrCode` is the cartridgeRecordId
 *  - `phase` is required
 *  - `view` is optional ('top' | 'bottom') — camera view the photo was shot
 *    from (top/bottom cartridge photos look completely different, so a model
 *    trains on / grades one view); any other non-empty value is a 400. When
 *    omitted, the view is auto-classified from barcode presence (barcode ⇒ top);
 *    the response reports `viewSource` ('manual' | 'barcode-auto' | null).
 *
 * New behavior:
 *  - Rejects with 400 if the QR doesn't match an existing CartridgeRecord.
 *    Induction is gone — the scripts can no longer auto-create cartridges.
 */
import { json } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvImage } from '$lib/server/db/models/cv-image.js';
import { CartridgeRecord } from '$lib/server/db/models/cartridge-record.js';
import { AuditLog } from '$lib/server/db/models/audit-log.js';
import { generateId } from '$lib/server/db/utils.js';
import { uploadViaWorker, getR2Url, buildCvNamedKey } from '$lib/server/services/r2';
import { detectBarcodePresence, BARCODE_VIEW, NO_BARCODE_VIEW } from '$lib/server/services/barcode-detect';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { runPhaseInference } from '$lib/server/cv/run-inference';
import type { RequestHandler } from './$types';

function pad(n: number): string {
	return String(n).padStart(3, '0');
}

export const POST: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await connectDB();

	const formData = await request.formData();
	const file = formData.get('file') as File | null;
	const qrCode = formData.get('qrCode')?.toString().trim();
	const phase = formData.get('phase')?.toString().trim() || 'wax_filled';
	const cameraIndexRaw = formData.get('cameraIndex')?.toString();
	const processingMode = formData.get('processingMode')?.toString() as 'full' | 'raw' | undefined;
	// Legacy projectId — silently ignored after the refactor.
	// const _legacyProjectId = formData.get('projectId');

	// Optional camera view (CV-PIPELINE-V2 top/bottom split) — empty string is
	// treated as "no view".
	const viewRaw = formData.get('view')?.toString().trim() || undefined;
	if (viewRaw !== undefined && viewRaw !== 'top' && viewRaw !== 'bottom') {
		return json({ error: `view must be 'top' or 'bottom'` }, { status: 400 });
	}
	const view = viewRaw as 'top' | 'bottom' | undefined;

	if (!file) return json({ error: 'file is required' }, { status: 400 });
	if (!qrCode) return json({ error: 'qrCode is required' }, { status: 400 });

	// Reject orphan scans — cartridge must exist.
	// Atomically bump photoSequence to mint cartridgeImageNumber.
	const updated = await CartridgeRecord.findOneAndUpdate(
		{ _id: qrCode },
		{ $inc: { photoSequence: 1 } },
		{ new: true, projection: { photoSequence: 1 } }
	).lean() as any;

	if (!updated) {
		return json({ error: `Cartridge ${qrCode} not found in BIMS` }, { status: 400 });
	}

	const seq = updated.photoSequence;
	const cartridgeImageNumber = `${qrCode}_${pad(seq)}`;

	const buffer = Buffer.from(await file.arrayBuffer());

	// Resolve the camera view (CV-PIPELINE-V2 top/bottom split). A manually posted
	// view always wins; otherwise auto-classify from barcode presence (the
	// cartridge barcode shows only in top photos). Detection never blocks or fails
	// a capture — a null result leaves the view untagged.
	let effectiveView: 'top' | 'bottom' | undefined = view;
	let viewSource: 'manual' | 'barcode-auto' | undefined = view ? 'manual' : undefined;
	if (!view) {
		const hasBarcode = await detectBarcodePresence(buffer);
		if (hasBarcode !== null) {
			effectiveView = hasBarcode ? BARCODE_VIEW : NO_BARCODE_VIEW;
			viewSource = 'barcode-auto';
		}
	}

	const id = generateId();
	const filename = file.name || `${cartridgeImageNumber}.png`;
	const key = buildCvNamedKey('captures', id, filename);
	const contentType = file.type || 'image/png';

	await uploadViaWorker(buffer, key, contentType);
	const publicUrl = getR2Url(key);

	const capturedAt = new Date();
	const image = await CvImage.create({
		_id: id,
		filename,
		filePath: key,
		fileSizeBytes: buffer.length,
		cameraIndex: cameraIndexRaw ? Number.parseInt(cameraIndexRaw, 10) : undefined,
		capturedAt,
		imageUrl: publicUrl,
		processingMode: processingMode === 'raw' || processingMode === 'full' ? processingMode : undefined,
		cartridgeTag: { cartridgeRecordId: qrCode, phase },
		cartridgeImageNumber,
		...(effectiveView ? { view: effectiveView } : {}),
		...(viewSource ? { viewSource } : {})
	});

	await CartridgeRecord.updateOne(
		{ _id: qrCode },
		{ $push: { photos: { imageId: id, phase, capturedAt, r2Key: key, r2Url: publicUrl, cartridgeImageNumber } } }
	);

	await AuditLog.create({
		_id: generateId(),
		tableName: 'cv_images',
		recordId: id,
		action: 'INSERT',
		newData: { source: 'capture-ingest', cartridgeRecordId: qrCode, phase, view: effectiveView ?? null, viewSource: viewSource ?? null, key, cartridgeImageNumber, processingMode },
		changedAt: capturedAt,
		changedBy: 'cv-capture-agent',
		reason: 'capture-ingest'
	});

	// Fire-and-forget phase-X auto-inference for any project deployed at this phase.
	runPhaseInference({
		imageId: id,
		imageUrl: publicUrl,
		cartridgeRecordId: qrCode,
		phase,
		view: effectiveView ?? null,
		triggeredBy: 'auto-on-capture'
	}).catch(err => console.error('[capture-ingest] phase-inference failed:', err));

	return json({
		imageId: id,
		cartridgeImageNumber,
		key,
		cartridgeRecordId: qrCode,
		phase,
		view: effectiveView ?? null,
		viewSource: viewSource ?? null
	}, { status: 201 });
};
