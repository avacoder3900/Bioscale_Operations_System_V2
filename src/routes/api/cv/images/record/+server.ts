/**
 * POST /api/cv/images/record — presign companion.
 *
 * The browser uploaded the file to R2 via a presigned key; this records it.
 * Creates a technical CvImage row and appends the full photo truth to
 * cartridge_records.photos[] (R2 pointer, capture metadata, optional
 * labels/notes, qcLabel placeholder). Mirrors /api/cv/capture's data shape.
 */
import { json, error } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvImage } from '$lib/server/db/models/cv-image.js';
import { CartridgeRecord } from '$lib/server/db/models/cartridge-record.js';
import { generateId } from '$lib/server/db/utils.js';
import { getR2Url, deleteViaWorker } from '$lib/server/services/r2';
import type { RequestHandler } from './$types';

function pad(n: number): string {
	return String(n).padStart(3, '0');
}

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	const { key, filename, fileSize, cartridgeTag } = await request.json();
	if (!key || !filename) {
		return json({ error: 'key and filename are required' }, { status: 400 });
	}
	// projectId is no longer accepted — images live free of projects after the
	// cartridge-first refactor.

	// cartridgeTag is required — every image must be of a cartridge.
	const cartridgeRecordId: string | undefined = cartridgeTag?.cartridgeRecordId;
	const phase: string | undefined = cartridgeTag?.phase;
	if (!cartridgeRecordId || !phase) {
		// File already in R2 — clean up before returning.
		try { await deleteViaWorker(key); } catch { /* best-effort */ }
		return json({ error: 'cartridgeTag.cartridgeRecordId and cartridgeTag.phase are required' }, { status: 400 });
	}

	// Optional QC truth supplied at record time.
	const labels: string[] = Array.isArray(cartridgeTag?.labels)
		? cartridgeTag.labels.filter((l: unknown): l is string => typeof l === 'string')
		: [];
	const notes: string | undefined = cartridgeTag?.notes?.toString().trim() || undefined;

	// Validate cartridge exists. Reject orphan scans inline.
	// Atomically $inc photoSequence and grab the new value to mint cartridgeImageNumber.
	const updated = await CartridgeRecord.findOneAndUpdate(
		{ _id: cartridgeRecordId },
		{ $inc: { photoSequence: 1 } },
		{ new: true, projection: { photoSequence: 1 } }
	).lean() as any;

	if (!updated) {
		try { await deleteViaWorker(key); } catch { /* best-effort */ }
		return json({ error: `Cartridge ${cartridgeRecordId} not found in BIMS` }, { status: 400 });
	}

	const seq = updated.photoSequence;
	const cartridgeImageNumber = `${cartridgeRecordId}_${pad(seq)}`;
	const publicUrl = getR2Url(key);
	const capturedAt = new Date();
	const imageId = generateId();

	// Technical row only — photo truth lives on cartridge_records.photos[] below.
	const image = await CvImage.create({
		_id: imageId,
		cartridgeRecordId,
		phase,
		filename,
		fileSizeBytes: fileSize || 0
	});

	// Pipeline append (self-heals malformed legacy `photos` fields; $literal
	// stores the entry verbatim). Mirrors /api/cv/capture.
	const photoEntry = {
		imageId,
		phase,
		capturedAt,
		capturedBy: { _id: locals.user._id, username: locals.user.username },
		r2Key: key,
		r2Url: publicUrl,
		cartridgeImageNumber,
		qcLabel: null,
		...(labels.length > 0 ? { labels } : {}),
		...(notes ? { notes } : {})
	};
	await CartridgeRecord.updateOne(
		{ _id: cartridgeRecordId },
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
		{ updatePipeline: true }
	);

	return json({ data: JSON.parse(JSON.stringify(image)) }, { status: 201 });
};
