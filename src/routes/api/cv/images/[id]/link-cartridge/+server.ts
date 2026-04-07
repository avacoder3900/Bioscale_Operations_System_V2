/**
 * PATCH /api/cv/images/[id]/link-cartridge
 *
 * Links an existing cv_image to a cartridge record by setting its cartridgeTag.
 * Also pushes a photo ref to cartridge_records.photos[].
 * Used by the Labels tab "induct" button to retroactively link photos.
 */
import { json, error } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvImage } from '$lib/server/db/models/cv-image.js';
import { CartridgeRecord } from '$lib/server/db/models/cartridge-record.js';
import type { RequestHandler } from './$types';

export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	const { cartridgeRecordId, phase } = await request.json();
	if (!cartridgeRecordId) {
		return json({ error: 'cartridgeRecordId is required' }, { status: 400 });
	}

	const image = await CvImage.findById(params.id).lean();
	if (!image) return json({ error: 'Image not found' }, { status: 404 });

	// Update the image's cartridgeTag
	await CvImage.updateOne(
		{ _id: params.id },
		{ $set: { cartridgeTag: { cartridgeRecordId, phase: phase || 'wax_filled' } } }
	);

	// Push photo ref to cartridge record (if it exists)
	await CartridgeRecord.updateOne(
		{ _id: cartridgeRecordId },
		{ $push: { photos: {
			imageId: params.id,
			r2Key: (image as any).filePath || null,
			phase: phase || 'wax_filled',
			capturedAt: (image as any).capturedAt || (image as any).createdAt
		}}}
	);

	// Fetch updated cartridge for status feedback
	const cartridge = await CartridgeRecord.findById(cartridgeRecordId)
		.select('_id status photos')
		.lean() as any;

	return json({
		success: true,
		cartridgeRecordId,
		imageId: params.id,
		cartridgeExists: !!cartridge,
		cartridgeStatus: cartridge?.status ?? null,
		photoCount: cartridge?.photos?.length ?? 0
	});
};
