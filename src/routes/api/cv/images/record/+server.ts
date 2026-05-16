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

	const { projectId, key, filename, contentType, fileSize, cartridgeTag } = await request.json();
	if (!key || !filename) {
		return json({ error: 'key and filename are required' }, { status: 400 });
	}
	// projectId is no longer required — images live free of projects after the
	// cartridge-first refactor. If a caller still passes it, ignore it.

	// cartridgeTag is now required — every image must be of a cartridge.
	const cartridgeRecordId: string | undefined = cartridgeTag?.cartridgeRecordId;
	const phase: string | undefined = cartridgeTag?.phase;
	if (!cartridgeRecordId || !phase) {
		// File already in R2 — clean up before returning.
		try { await deleteViaWorker(key); } catch { /* best-effort */ }
		return json({ error: 'cartridgeTag.cartridgeRecordId and cartridgeTag.phase are required' }, { status: 400 });
	}

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

	const image = await CvImage.create({
		_id: generateId(),
		filename,
		filePath: key,
		fileSizeBytes: fileSize || 0,
		capturedAt,
		capturedBy: { _id: locals.user._id, username: locals.user.username },
		imageUrl: publicUrl,
		cartridgeTag: {
			cartridgeRecordId,
			phase,
			labels: cartridgeTag?.labels ?? [],
			notes: cartridgeTag?.notes ?? ''
		},
		cartridgeImageNumber
	});

	// Push the photo ref onto the cartridge for fast DHR queries.
	await CartridgeRecord.updateOne(
		{ _id: cartridgeRecordId },
		{ $push: { photos: {
			imageId: image._id,
			phase,
			capturedAt,
			r2Key: key,
			r2Url: publicUrl,
			cartridgeImageNumber
		}}}
	);

	return json({ data: JSON.parse(JSON.stringify(image)) }, { status: 201 });
};
