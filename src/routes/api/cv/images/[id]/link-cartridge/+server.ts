/**
 * PATCH /api/cv/images/[id]/link-cartridge
 *
 * Retroactively links an existing image to a cartridge. Use case: operator
 * finds a legacy untagged image in /cv/stream and wants to fix its lineage.
 *
 * Behavior:
 *  - Rejects if the cartridge doesn't exist (orphan-reject rule).
 *  - Mints cartridgeImageNumber by atomically bumping CartridgeRecord.photoSequence.
 *  - Pushes the photo ref into CartridgeRecord.photos[].
 *  - If the image already has a cartridgeTag set, returns 409 — operator must
 *    explicitly call an "unlink first" path; we don't silently re-tag.
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

	if (image.cartridgeTag?.cartridgeRecordId) {
		return json({
			error: 'Image already tagged. Unlink first if you need to retag.',
			currentCartridgeId: image.cartridgeTag.cartridgeRecordId,
			currentPhase: image.cartridgeTag.phase
		}, { status: 409 });
	}

	// Atomic increment — also serves as "cartridge exists" check.
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

	await CvImage.updateOne(
		{ _id: params.id },
		{ $set: {
			cartridgeTag: { cartridgeRecordId, phase, labels: [], notes: '' },
			cartridgeImageNumber
		}}
	);

	await CartridgeRecord.updateOne(
		{ _id: cartridgeRecordId },
		{ $push: { photos: {
			imageId: params.id,
			phase,
			capturedAt,
			r2Key: image.filePath ?? null,
			r2Url: image.imageUrl ?? null,
			cartridgeImageNumber
		}}}
	);

	return json({
		success: true,
		cartridgeRecordId,
		imageId: params.id,
		cartridgeImageNumber
	});
};
