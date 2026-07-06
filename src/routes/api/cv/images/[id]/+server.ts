/**
 * GET    /api/cv/images/[id] — one photo: cartridge_records.photos[] truth
 *                              merged with the CvImage technical/derived row.
 * DELETE /api/cv/images/[id] — remove the photo entry from its cartridge,
 *                              renumber siblings, delete the CvImage row and
 *                              the R2 object(s).
 *
 * Photo truth (r2Url/qcLabel/labels/notes/annotations/cartridgeImageNumber)
 * lives ONLY on cartridge_records.photos[]. CvImage holds derived technicals
 * (dimensions, embedding, processing provenance).
 */
import { json, error } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvImage } from '$lib/server/db/models/cv-image.js';
import { CartridgeRecord } from '$lib/server/db/models/cartridge-record.js';
import { AuditLog } from '$lib/server/db/models/index.js';
import { generateId } from '$lib/server/db/utils.js';
import { getPhotoByImageId } from '$lib/server/cv/photo-truth.js';
import { deleteFromR2 } from '$lib/server/services/r2';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	const found = await getPhotoByImageId(params.id);
	if (!found) return json({ error: 'Image not found' }, { status: 404 });

	const tech = await CvImage.findById(params.id).lean() as any;

	// Merge truth + technical into one row. imageUrl/filePath keys are kept for
	// existing consumers, sourced from the photo entry's r2Url/r2Key.
	const { photo } = found;
	const data = {
		_id: params.id,
		imageId: params.id,
		cartridgeRecordId: found.cartridgeRecordId,
		phase: photo.phase,
		capturedAt: photo.capturedAt ?? null,
		capturedBy: photo.capturedBy ?? null,
		cartridgeImageNumber: photo.cartridgeImageNumber ?? null,
		imageUrl: photo.r2Url ?? null,
		r2Url: photo.r2Url ?? null,
		filePath: photo.r2Key ?? null,
		r2Key: photo.r2Key ?? null,
		qcLabel: photo.qcLabel ?? null,
		labels: photo.labels ?? [],
		notes: photo.notes ?? '',
		annotations: photo.annotations ?? [],
		// Technical/derived fields (may be absent if the row was never created).
		filename: tech?.filename ?? null,
		width: tech?.width ?? null,
		height: tech?.height ?? null,
		fileSizeBytes: tech?.fileSizeBytes ?? null,
		cameraIndex: tech?.cameraIndex ?? null,
		processingMode: tech?.processingMode ?? null,
		metadata: tech?.metadata ?? null
	};

	return json({ data: JSON.parse(JSON.stringify(data)) });
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	try {
		const found = await getPhotoByImageId(params.id);
		if (!found) return json({ error: 'Image not found' }, { status: 404 });

		const { cartridgeRecordId, photo } = found;
		const cartridgeImageNumber = photo.cartridgeImageNumber;
		const seqMatch = cartridgeImageNumber?.match(/_(\d+)$/);
		const deletedSeq = seqMatch ? parseInt(seqMatch[1], 10) : null;

		// R2 cleanup is best-effort: orphan storage is acceptable; a stale DB row
		// is not. r2Key is the photo-entry pointer (the only key that exists now).
		try {
			if (photo.r2Key) await deleteFromR2(photo.r2Key);
		} catch { /* best effort */ }

		// Tighten the cartridge's photo ledger:
		//   1. Pull the deleted photo's entry from photos[]
		//   2. Decrement photoSequence so the counter stays in sync
		//   3. Renumber any sibling photos with a higher seq so displayed numbers
		//      stay sequential (1-2-3-4) instead of gapping after a delete.
		await CartridgeRecord.updateOne(
			{ _id: cartridgeRecordId },
			{
				$pull: { photos: { imageId: params.id } },
				$inc: { photoSequence: -1 }
			}
		);

		if (deletedSeq !== null) {
			const cart = await CartridgeRecord.findById(cartridgeRecordId)
				.select('photos')
				.lean() as any;
			for (const p of (cart?.photos || [])) {
				const m: RegExpMatchArray | null = p.cartridgeImageNumber?.match(/_(\d+)$/);
				if (!m) continue;
				const oldSeq = parseInt(m[1], 10);
				if (oldSeq <= deletedSeq) continue;
				const newSeq = oldSeq - 1;
				const newNumber = p.cartridgeImageNumber.replace(/_\d+$/, `_${String(newSeq).padStart(3, '0')}`);
				// cartridgeImageNumber lives ONLY in photos[] now — nothing to update
				// on the CvImage row.
				await CartridgeRecord.updateOne(
					{ _id: cartridgeRecordId, 'photos.imageId': p.imageId },
					{ $set: { 'photos.$.cartridgeImageNumber': newNumber } }
				);
			}
		}

		// Drop the technical/derived row (loses nothing that can't be recomputed).
		await CvImage.findByIdAndDelete(params.id);

		await AuditLog.create({
			_id: generateId(),
			tableName: 'cartridge_records',
			recordId: cartridgeRecordId,
			action: 'DELETE',
			newData: { deletedPhoto: params.id, cartridgeImageNumber, phase: photo.phase },
			changedAt: new Date(),
			changedBy: locals.user.username
		});

		return json({ success: true });
	} catch (err: any) {
		return json({ error: err.message }, { status: 500 });
	}
};
