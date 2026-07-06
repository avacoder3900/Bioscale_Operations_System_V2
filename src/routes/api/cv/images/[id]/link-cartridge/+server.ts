/**
 * PATCH /api/cv/images/[id]/link-cartridge
 *
 * Retroactively links an existing (orphan) CvImage to a cartridge. Use case:
 * operator finds a legacy untagged image in /cv/stream and fixes its lineage.
 *
 * Behavior:
 *  - 409 if a photos[] entry with this imageId already exists on any cartridge
 *    (the image is already linked — operator must unlink first).
 *  - 400 if the target cartridge doesn't exist (orphan-reject rule).
 *  - 422 if the CvImage has no R2 pointer to carry onto the photo entry.
 *  - Mints cartridgeImageNumber by atomically bumping photoSequence.
 *  - Appends the FULL photo truth (r2Key/r2Url/qcLabel:null) to photos[].
 *  - Sets the CvImage's cartridgeRecordId/phase for reverse lookup.
 */
import { json, error } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvImage } from '$lib/server/db/models/cv-image.js';
import { CartridgeRecord } from '$lib/server/db/models/cartridge-record.js';
import type { RequestHandler } from './$types';

function pad(n: number): string {
	return String(n).padStart(3, '0');
}

export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	const { cartridgeRecordId, phase } = await request.json();
	if (!cartridgeRecordId || !phase) {
		return json({ error: 'cartridgeRecordId and phase are required' }, { status: 400 });
	}

	const image = await CvImage.findById(params.id).lean() as any;
	if (!image) return json({ error: 'Image not found' }, { status: 404 });

	// Already-linked check: a photo entry with this imageId on ANY cartridge
	// means the image is already tagged. Don't silently re-tag.
	const existing = await CartridgeRecord.findOne({ 'photos.imageId': params.id })
		.select('_id')
		.lean() as any;
	if (existing) {
		return json({
			error: 'Image already linked to a cartridge. Unlink first if you need to retag.',
			currentCartridgeId: existing._id
		}, { status: 409 });
	}

	// R2 pointers come off the (possibly legacy) CvImage doc. New technical rows
	// don't carry these, so fall back to the legacy imageUrl/filePath fields.
	const r2Url: string | null = image.r2Url ?? image.imageUrl ?? null;
	const r2Key: string | null = image.r2Key ?? image.filePath ?? null;
	if (!r2Url && !r2Key) {
		return json({
			error: 'Image has no R2 pointer (r2Url/r2Key) to link — cannot create a photo entry.'
		}, { status: 422 });
	}

	// Atomic increment — also serves as the "cartridge exists" check.
	const updated = await CartridgeRecord.findOneAndUpdate(
		{ _id: cartridgeRecordId },
		{ $inc: { photoSequence: 1 } },
		{ new: true, projection: { photoSequence: 1 } }
	).lean() as any;

	if (!updated) {
		return json({ error: `Cartridge ${cartridgeRecordId} not found in BIMS` }, { status: 400 });
	}

	const seq = updated.photoSequence;
	const cartridgeImageNumber = `${cartridgeRecordId}_${pad(seq)}`;
	const capturedAt = image.capturedAt || image.createdAt || new Date();

	// Full photo truth appended via pipeline (self-heals malformed legacy
	// `photos` fields; $literal stores the entry verbatim).
	const photoEntry = {
		imageId: params.id,
		phase,
		capturedAt,
		capturedBy: { _id: locals.user._id, username: locals.user.username },
		r2Key,
		r2Url,
		cartridgeImageNumber,
		qcLabel: null
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

	// Point the technical row back at the cartridge for reverse lookup.
	await CvImage.updateOne(
		{ _id: params.id },
		{ $set: { cartridgeRecordId, phase } }
	);

	return json({
		success: true,
		cartridgeRecordId,
		imageId: params.id,
		cartridgeImageNumber
	});
};
