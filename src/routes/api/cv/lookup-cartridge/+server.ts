/**
 * GET /api/cv/lookup-cartridge?code=CART-000123
 *
 * Looks up a cartridge by QR code and returns its CV phase history.
 * Queries cv_images for prior photos, determines the next phase in the pipeline.
 */
import { json, error } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvImage } from '$lib/server/db/models/cv-image.js';
import { CartridgeRecord } from '$lib/server/db/models/cartridge-record.js';
import type { RequestHandler } from './$types';

const PHASE_PIPELINE = [
	'wax_filled',
	'reagent_filled',
	'inspected',
	'sealed',
	'oven_cured',
	'qaqc_released'
] as const;

function getNextPhase(currentPhase: string | null): string {
	if (!currentPhase) return PHASE_PIPELINE[0];
	const idx = PHASE_PIPELINE.indexOf(currentPhase as any);
	if (idx === -1) return PHASE_PIPELINE[0];
	if (idx >= PHASE_PIPELINE.length - 1) return currentPhase; // already complete
	return PHASE_PIPELINE[idx + 1];
}

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');

	const code = url.searchParams.get('code')?.trim();
	if (!code) return json({ error: 'code parameter is required' }, { status: 400 });

	await connectDB();

	// Check if cartridge record exists
	const cartridge = await CartridgeRecord.findById(code).select('_id status').lean();

	// Find all cv_images tagged with this cartridge, sorted newest first
	const previousImages = await CvImage.find({ 'cartridgeTag.cartridgeRecordId': code })
		.select('_id cartridgeTag.phase capturedAt imageUrl')
		.sort({ capturedAt: -1 })
		.lean();

	const currentPhase = previousImages.length > 0
		? (previousImages[0] as any).cartridgeTag?.phase || null
		: null;

	const nextPhase = getNextPhase(currentPhase);
	const isNew = previousImages.length === 0;
	const isComplete = currentPhase === 'qaqc_released';

	return json({
		cartridgeRecordId: cartridge ? (cartridge as any)._id : null,
		currentPhase,
		nextPhase,
		isNew,
		isComplete,
		pipelineIndex: PHASE_PIPELINE.indexOf(nextPhase as any),
		pipelineLength: PHASE_PIPELINE.length,
		previousImages: JSON.parse(JSON.stringify(
			previousImages.map((img: any) => ({
				id: img._id,
				phase: img.cartridgeTag?.phase,
				capturedAt: img.capturedAt,
				imageUrl: img.imageUrl
			}))
		))
	});
};
