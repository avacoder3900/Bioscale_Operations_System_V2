import { redirect } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection';
import { cvFetch, cvThumbUrl, cvImageUrl } from '$lib/server/cv-api';
import type { PageServerLoad } from './$types';
import type { ImageResponse, InspectionResponse } from '$lib/types/cv';

export const load: PageServerLoad = async ({ locals, params }) => {
	if (!locals.user) redirect(302, '/login');

	const cartridgeId = params.id;

	// Load cartridge record from BIMS MongoDB
	await connectDB();
	const { default: mongoose } = await import('mongoose');
	const CartridgeRecord = mongoose.models.CartridgeRecord;

	let cartridge: Record<string, unknown> | null = null;
	if (CartridgeRecord) {
		const doc = await CartridgeRecord.findById(cartridgeId).lean();
		if (doc) {
			cartridge = JSON.parse(JSON.stringify(doc));
		}
	}

	// Fetch all images tagged with this cartridge from CV API
	let images: ImageResponse[] = [];
	try {
		images = await cvFetch<ImageResponse[]>('/api/v1/images', {
			params: { cartridge_id: cartridgeId, limit: '200' }
		});
	} catch { /* CV API may not have images for this cartridge */ }

	// Fetch inspections for related samples
	const sampleIds = [...new Set(images.map((img) => img.sample_id))];
	let inspections: InspectionResponse[] = [];
	for (const sampleId of sampleIds) {
		try {
			const sampleInspections = await cvFetch<InspectionResponse[]>('/api/inspections', {
				params: { sample_id: sampleId }
			});
			inspections.push(
				...sampleInspections.filter((i) => i.cartridge_record_id === cartridgeId)
			);
		} catch { /* skip */ }
	}

	const inspectionByImage = new Map(inspections.map((i) => [i.image_id, i]));

	const imagesWithData = images.map((img) => {
		const insp = inspectionByImage.get(img.id);
		return {
			...img,
			thumbUrl: cvThumbUrl(img.id),
			fullUrl: cvImageUrl(img.id),
			inspection: insp
				? {
						id: insp.id,
						status: insp.status,
						result: insp.result,
						confidence_score: insp.confidence_score,
						defects: insp.defects,
						model_version: insp.model_version,
						processing_time_ms: insp.processing_time_ms,
						created_at: insp.created_at
					}
				: null
		};
	});

	imagesWithData.sort(
		(a, b) => new Date(b.captured_at).getTime() - new Date(a.captured_at).getTime()
	);

	const phases = [...new Set(imagesWithData.map((img) => img.cartridge_tag?.phase || 'untagged'))];

	return {
		cartridgeId,
		cartridge: cartridge
			? {
					_id: (cartridge as Record<string, unknown>)._id as string,
					currentPhase: (cartridge as Record<string, unknown>).currentPhase as string,
					createdAt: (cartridge as Record<string, unknown>).createdAt as string
				}
			: null,
		images: imagesWithData,
		phases,
		inspectionCount: inspections.length,
		passCount: inspections.filter((i) => i.result === 'pass').length,
		failCount: inspections.filter((i) => i.result === 'fail').length
	};
};
