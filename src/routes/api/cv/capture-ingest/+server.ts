/**
 * POST /api/cv/capture-ingest
 *
 * Agent-keyed multipart upload from the Python capture scripts
 * (camera_capture.py and camera_capture_NO_POST_PROCESSING.py).
 *
 * Backwards-compatible contract for the old lab scripts:
 *  - Still accepts the same multipart fields they send today
 *  - `projectId` is silently ignored (CvImage lives off projects now)
 *  - `qrCode` is the cartridgeRecordId
 *  - `phase` is required (defaults to wax_filled for the legacy scripts)
 *
 * New behavior:
 *  - Rejects with 400 if the QR doesn't match an existing CartridgeRecord.
 *    Induction is gone — the scripts can no longer auto-create cartridges.
 *  - CvImage row is technical/derived only; cartridge_records.photos[] carries
 *    the full photo truth (R2 pointer + capture metadata + QC placeholder).
 */
import { json } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvImage } from '$lib/server/db/models/cv-image.js';
import { CartridgeRecord } from '$lib/server/db/models/cartridge-record.js';
import { AuditLog } from '$lib/server/db/models/audit-log.js';
import { generateId } from '$lib/server/db/utils.js';
import { uploadViaWorker, getR2Url, buildCvNamedKey } from '$lib/server/services/r2';
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
	const cameraIndexRaw = formData.get('cameraIndex')?.toString();
	const processingMode = formData.get('processingMode')?.toString() as 'full' | 'raw' | undefined;
	// Legacy projectId — silently ignored after the refactor.
	// const _legacyProjectId = formData.get('projectId');

	// Photo type: 'inspection' (default — standard station photos, phase-bound)
	// or 'microscope' (timed grid sequence; a photo DESCRIPTOR, not a mfg state:
	// phase stays null and phase-based inference is skipped).
	const photoTypeRaw = formData.get('photoType')?.toString();
	const photoType = photoTypeRaw === 'microscope' ? 'microscope' : 'inspection';
	const phase =
		photoType === 'microscope'
			? null
			: formData.get('phase')?.toString().trim() || 'wax_filled';

	// Microscope grid-sequence identity (all optional; stamped by the station
	// agent): sequenceId groups one run, sequenceIndex = order taken,
	// locationRow/locationCol = named grid slot (e.g. B / 4).
	const sequenceId = formData.get('sequenceId')?.toString().trim() || undefined;
	const sequenceIndexRaw = formData.get('sequenceIndex')?.toString();
	const sequenceIndex = sequenceIndexRaw ? Number.parseInt(sequenceIndexRaw, 10) : undefined;
	const locationRow = formData.get('locationRow')?.toString().trim() || undefined;
	const locationColRaw = formData.get('locationCol')?.toString();
	const locationCol = locationColRaw ? Number.parseInt(locationColRaw, 10) : undefined;

	if (!file) return json({ error: 'file is required' }, { status: 400 });
	if (!qrCode) return json({ error: 'qrCode is required' }, { status: 400 });
	if (sequenceIndex !== undefined && (Number.isNaN(sequenceIndex) || sequenceIndex < 1)) {
		return json({ error: 'sequenceIndex must be a positive integer' }, { status: 400 });
	}

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
	const id = generateId();
	const filename = file.name || `${cartridgeImageNumber}.png`;
	const key = buildCvNamedKey('captures', id, filename);
	const contentType = file.type || 'image/png';

	await uploadViaWorker(buffer, key, contentType);
	const publicUrl = getR2Url(key);

	const capturedAt = new Date();
	// Technical row only — the photo truth (R2 pointer, capture metadata, QC)
	// lives on cartridge_records.photos[] below.
	await CvImage.create({
		_id: id,
		cartridgeRecordId: qrCode,
		phase,
		filename,
		fileSizeBytes: buffer.length,
		cameraIndex: cameraIndexRaw ? Number.parseInt(cameraIndexRaw, 10) : undefined,
		processingMode: processingMode === 'raw' || processingMode === 'full' ? processingMode : undefined
	});

	// A batch of legacy cartridges have a malformed (non-array) `photos` field,
	// so a plain $push throws. Use a pipeline update to coerce photos to [] when
	// it isn't an array, then append — atomic and self-healing. $literal keeps
	// the entry stored verbatim (so a '$' or '.' in any value isn't parsed).
	const photoEntry = {
		imageId: id,
		phase,
		capturedAt,
		r2Key: key,
		r2Url: publicUrl,
		cartridgeImageNumber,
		qcLabel: null,
		photoType,
		...(sequenceId ? { sequenceId } : {}),
		...(sequenceIndex !== undefined ? { sequenceIndex } : {}),
		...(locationRow || locationCol !== undefined
			? { location: { ...(locationRow ? { row: locationRow } : {}), ...(locationCol !== undefined ? { col: locationCol } : {}) } }
			: {})
	};
	await CartridgeRecord.updateOne(
		{ _id: qrCode },
		[
			{
				$set: {
					photos: {
						$concatArrays: [
							{ $cond: [{ $isArray: '$photos' }, '$photos', []] },
							{ $literal: [photoEntry] }
						]
					}
				}
			}
		],
		// Mongoose 9 requires opting in to array (aggregation-pipeline) updates.
		{ updatePipeline: true }
	);

	await AuditLog.create({
		_id: generateId(),
		tableName: 'cv_images',
		recordId: id,
		action: 'INSERT',
		newData: {
			source: 'capture-ingest', cartridgeRecordId: qrCode, phase, key, cartridgeImageNumber,
			processingMode, photoType,
			...(sequenceId ? { sequenceId, sequenceIndex, locationRow, locationCol } : {})
		},
		changedAt: capturedAt,
		changedBy: 'cv-capture-agent',
		reason: 'capture-ingest'
	});

	// Fire-and-forget phase-X auto-inference for any project deployed at this
	// phase. Microscope photos have no phase — nothing routes; skip entirely.
	if (phase) {
		runPhaseInference({
			imageId: id,
			imageUrl: publicUrl,
			cartridgeRecordId: qrCode,
			phase,
			triggeredBy: 'auto-on-capture'
		}).catch(err => console.error('[capture-ingest] phase-inference failed:', err));
	}

	return json({
		imageId: id,
		cartridgeImageNumber,
		key,
		cartridgeRecordId: qrCode,
		phase,
		photoType,
		...(sequenceId ? { sequenceId, sequenceIndex, location: { row: locationRow, col: locationCol } } : {})
	}, { status: 201 });
};
