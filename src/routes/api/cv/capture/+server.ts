/**
 * POST /api/cv/capture
 *
 * Single-call cartridge-first capture endpoint. Replaces the presign+record
 * two-step for the new /capture page and inline manufacturing buttons.
 *
 * Request (multipart/form-data):
 *   file:           image blob
 *   cartridgeId:    required — must match an existing CartridgeRecord
 *   phase:          required — manufacturing phase or 'post_run' for R&D
 *   cameraIndex:    optional
 *   processingMode: optional 'full' | 'raw'
 *
 * Behavior:
 *   1. Auth: cv:write OR manufacturing:write (inline mfg buttons use the latter).
 *   2. Validate cartridge exists; 400 if not (orphan-reject rule).
 *   3. Atomically $inc CartridgeRecord.photoSequence to mint cartridgeImageNumber.
 *   4. Upload file via R2 Worker.
 *   5. Create CvImage doc.
 *   6. Push photo ref to CartridgeRecord.photos[].
 *   7. Return { imageId, cartridgeImageNumber, imageUrl, phase }.
 *
 * Future (PRD 3 Phase 4): fire-and-forget phase-X auto-inference here.
 */
import { json, error } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvImage } from '$lib/server/db/models/cv-image.js';
import { CartridgeRecord } from '$lib/server/db/models/cartridge-record.js';
import { generateId } from '$lib/server/db/utils.js';
import { uploadViaWorker, getR2Url, buildCvNamedKey } from '$lib/server/services/r2';
import { hasPermission } from '$lib/server/permissions';
import { runPhaseInference } from '$lib/server/cv/run-inference';
import type { RequestHandler } from './$types';

function pad(n: number): string {
	return String(n).padStart(3, '0');
}

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');

	if (!hasPermission(locals.user, 'cv:write') && !hasPermission(locals.user, 'manufacturing:write')) {
		throw error(403, 'Forbidden');
	}

	await connectDB();

	const formData = await request.formData();
	const file = formData.get('file') as File | null;
	const cartridgeId = formData.get('cartridgeId')?.toString().trim();
	const phase = formData.get('phase')?.toString().trim();
	const cameraIndexRaw = formData.get('cameraIndex')?.toString();
	const processingMode = formData.get('processingMode')?.toString() as 'full' | 'raw' | undefined;

	// Optional R&D forensic notes — only set when /cv/forensic-capture sends one.
	const forensicNotes = formData.get('forensicNotes')?.toString().trim() || undefined;
	const forensic = forensicNotes ? { notes: forensicNotes } : undefined;

	if (!file) return json({ error: 'file is required' }, { status: 400 });
	if (!cartridgeId) return json({ error: 'cartridgeId is required' }, { status: 400 });
	if (!phase) return json({ error: 'phase is required' }, { status: 400 });

	// Atomic $inc serves double duty: validates cartridge exists AND mints a
	// race-free sequence number. null updated = cartridge doesn't exist.
	const updated = await CartridgeRecord.findOneAndUpdate(
		{ _id: cartridgeId },
		{ $inc: { photoSequence: 1 } },
		{ new: true, projection: { photoSequence: 1 } }
	).lean() as any;

	if (!updated) {
		return json({ error: `Cartridge ${cartridgeId} not found in BIMS` }, { status: 400 });
	}

	const seq = updated.photoSequence;
	const cartridgeImageNumber = `${cartridgeId}_${pad(seq)}`;

	const buffer = Buffer.from(await file.arrayBuffer());
	const imageId = generateId();
	const filenameFromClient = file.name || `${cartridgeImageNumber}.jpg`;
	const key = buildCvNamedKey('captures', imageId, `${cartridgeImageNumber}-${filenameFromClient}`);
	const contentType = file.type || 'image/jpeg';

	await uploadViaWorker(buffer, key, contentType);
	const publicUrl = getR2Url(key);

	const capturedAt = new Date();
	await CvImage.create({
		_id: imageId,
		filename: filenameFromClient,
		filePath: key,
		fileSizeBytes: buffer.length,
		cameraIndex: cameraIndexRaw ? Number.parseInt(cameraIndexRaw, 10) : undefined,
		capturedAt,
		capturedBy: { _id: locals.user._id, username: locals.user.username },
		imageUrl: publicUrl,
		processingMode: processingMode === 'raw' || processingMode === 'full' ? processingMode : undefined,
		cartridgeTag: { cartridgeRecordId: cartridgeId, phase },
		cartridgeImageNumber,
		...(forensic ? { metadata: { forensic } } : {})
	});

	await CartridgeRecord.updateOne(
		{ _id: cartridgeId },
		{ $push: { photos: { imageId, phase, capturedAt, r2Key: key, r2Url: publicUrl, cartridgeImageNumber } } }
	);

	// Fire-and-forget: any project deploying at this phase runs inference.
	// Errors are swallowed inside runPhaseInference — capture response always
	// succeeds regardless of inference state.
	runPhaseInference({
		imageId,
		imageUrl: publicUrl,
		cartridgeRecordId: cartridgeId,
		phase,
		triggeredBy: 'auto-on-capture'
	}).catch(err => console.error('[capture] phase-inference failed:', err));

	return json({
		imageId,
		cartridgeImageNumber,
		cartridgeRecordId: cartridgeId,
		phase,
		imageUrl: publicUrl,
		filePath: key
	}, { status: 201 });
};
