import { error } from '@sveltejs/kit';
import { connectDB, CartridgeRecord } from '$lib/server/db';
import { getImages, getInspectionsByCartridge, cvImageUrl } from '$lib/server/cv-api';
import type { PageServerLoad } from './$types';
import type { ImageResponse, InspectionResponse } from '$lib/types/cv';

export const load: PageServerLoad = async ({ params }) => {
	const cartridgeId = params.id;

	await connectDB();

	const cartridge = await CartridgeRecord.findById(cartridgeId).lean();
	if (!cartridge) {
		throw error(404, 'Cartridge not found');
	}

	let images: ImageResponse[] = [];
	let inspections: InspectionResponse[] = [];
	let cvError: string | null = null;

	try {
		const [imagesResult, inspectionsResult] = await Promise.allSettled([
			getImages({ cartridge_id: cartridgeId }),
			getInspectionsByCartridge(cartridgeId)
		]);

		if (imagesResult.status === 'fulfilled') images = imagesResult.value;
		if (inspectionsResult.status === 'fulfilled') inspections = inspectionsResult.value;

		if (imagesResult.status === 'rejected' && inspectionsResult.status === 'rejected') {
			cvError = 'Unable to connect to CV API.';
		}
	} catch (e) {
		cvError = e instanceof Error ? e.message : 'Failed to load CV data';
	}

	const cartridgeData = JSON.parse(JSON.stringify(cartridge));

	return {
		cartridge: {
			_id: cartridgeData._id,
			currentPhase: cartridgeData.currentPhase,
			createdAt: cartridgeData.createdAt,
			updatedAt: cartridgeData.updatedAt
		},
		images,
		inspections,
		cvError,
		cvBaseUrl: cvImageUrl('').replace('/api/v1/images//file', '')
	};
};
