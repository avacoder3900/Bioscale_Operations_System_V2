import { json, error } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvImage } from '$lib/server/db/models/cv-image.js';
import { CvProject } from '$lib/server/db/models/cv-project.js';
import { CartridgeRecord } from '$lib/server/db/models/cartridge-record.js';
import { deleteFromR2 } from '$lib/server/services/r2';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	const image = await CvImage.findById(params.id).lean();
	if (!image) return json({ error: 'Image not found' }, { status: 404 });

	return json({ data: JSON.parse(JSON.stringify(image)) });
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	try {
		const image = await CvImage.findById(params.id).lean() as any;
		if (!image) return json({ error: 'Image not found' }, { status: 404 });

		// Capture the cartridge link and sequence number BEFORE deleting — needed
		// for cleanup of CartridgeRecord.photos[] and to renumber sibling photos.
		const cartridgeRecordId: string | undefined = image.cartridgeTag?.cartridgeRecordId;
		const cartridgeImageNumber: string | undefined = image.cartridgeImageNumber;
		const seqMatch = cartridgeImageNumber?.match(/_(\d+)$/);
		const deletedSeq = seqMatch ? parseInt(seqMatch[1], 10) : null;

		// R2 cleanup is best-effort: orphan storage is acceptable; missing DB rows are not.
		try {
			if (image.filePath) await deleteFromR2(image.filePath);
			if (image.thumbnailPath) await deleteFromR2(image.thumbnailPath);
		} catch { /* best effort */ }

		await CvImage.findByIdAndDelete(params.id);

		// Tighten the cartridge's photo ledger:
		//   1. Pull the deleted photo's entry from photos[]
		//   2. Decrement photoSequence so the counter stays in sync
		//   3. Renumber any sibling photos with a higher seq so displayed numbers
		//      stay sequential (1-2-3-4) instead of gapping (1-3-4 after a delete).
		if (cartridgeRecordId) {
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
					await CvImage.updateOne(
						{ _id: p.imageId },
						{ $set: { cartridgeImageNumber: newNumber } }
					);
					await CartridgeRecord.updateOne(
						{ _id: cartridgeRecordId, 'photos.imageId': p.imageId },
						{ $set: { 'photos.$.cartridgeImageNumber': newNumber } }
					);
				}
			}
		}

		// Legacy image rows still carry a projectId — preserve existing decrement.
		if (image.projectId) {
			const dec: Record<string, number> = { imageCount: -1 };
			if (image.label === 'approved' || image.label === 'rejected') {
				dec.annotatedCount = -1;
			}
			await CvProject.findByIdAndUpdate(image.projectId, { $inc: dec });
		}

		return json({ success: true });
	} catch (err: any) {
		return json({ error: err.message }, { status: 500 });
	}
};
