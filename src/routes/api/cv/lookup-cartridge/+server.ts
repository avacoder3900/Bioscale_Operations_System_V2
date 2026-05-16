/**
 * GET /api/cv/lookup-cartridge?code=CART-000123
 *
 * Validates a scanned QR. Returns 404 if cartridge doesn't exist (induction
 * is gone — capture endpoints reject orphan scans).
 *
 * Used by the new /capture page after the operator scans: if the cartridge
 * is valid, the page makes it the sticky context for subsequent photos.
 */
import { json, error } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvImage } from '$lib/server/db/models/cv-image.js';
import { CartridgeRecord } from '$lib/server/db/models/cartridge-record.js';
import { getR2Url } from '$lib/server/services/r2';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');

	const code = url.searchParams.get('code')?.trim();
	if (!code) return json({ error: 'code parameter is required' }, { status: 400 });

	await connectDB();

	const cartridge = await CartridgeRecord.findById(code)
		.select('_id status photoSequence')
		.lean() as any;

	if (!cartridge) {
		return json({ error: `Cartridge ${code} not found in BIMS` }, { status: 404 });
	}

	// Recent photos for this cartridge — informational, helps the capture UI
	// show "you've already captured N photos of this cart" to the operator.
	const recentPhotos = await CvImage.find({ 'cartridgeTag.cartridgeRecordId': code })
		.select('_id cartridgeImageNumber cartridgeTag.phase capturedAt filePath imageUrl qcLabel')
		.sort({ capturedAt: -1 })
		.limit(20)
		.lean();

	const photosPayload = (recentPhotos as any[]).map((img) => ({
		id: img._id,
		cartridgeImageNumber: img.cartridgeImageNumber,
		phase: img.cartridgeTag?.phase,
		qcLabel: img.qcLabel,
		capturedAt: img.capturedAt,
		url: img.imageUrl || (img.filePath ? getR2Url(img.filePath) : null)
	}));

	return json({
		cartridgeRecordId: cartridge._id,
		status: cartridge.status,
		photoCount: cartridge.photoSequence ?? 0,
		recentPhotos: JSON.parse(JSON.stringify(photosPayload))
	});
};
