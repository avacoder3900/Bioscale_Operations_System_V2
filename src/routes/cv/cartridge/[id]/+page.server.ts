import { redirect } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvInspection } from '$lib/server/db/models/cv-inspection.js';
import { CvImage } from '$lib/server/db/models/cv-image.js';
import { CartridgeRecord } from '$lib/server/db/models/cartridge-record.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.user) redirect(302, '/login');
	await connectDB();

	const cartridgeId = params.id;

	// Load cartridge record
	let cartridge: any = null;
	try {
		const doc = await CartridgeRecord.findById(cartridgeId).lean();
		if (doc) cartridge = JSON.parse(JSON.stringify(doc));
	} catch { /* may not exist */ }

	// Load inspections for this cartridge
	const inspections = await CvInspection.find({ cartridgeRecordId: cartridgeId })
		.sort({ createdAt: -1 })
		.lean();

	// Load related images
	const imageIds = [...new Set((inspections as any[]).map(i => i.imageId).filter(Boolean))];
	const images = imageIds.length > 0
		? await CvImage.find({ _id: { $in: imageIds } }).lean()
		: [];
	const imageMap: Record<string, any> = {};
	for (const img of images as any[]) {
		imageMap[img._id] = img;
	}

	// Group inspections by phase
	const phases = [...new Set((inspections as any[]).map(i => i.phase || 'untagged'))];

	const passCount = (inspections as any[]).filter(i => i.result === 'pass').length;
	const failCount = (inspections as any[]).filter(i => i.result === 'fail').length;

	return {
		cartridgeId,
		cartridge,
		inspections: JSON.parse(JSON.stringify(inspections)),
		imageMap: JSON.parse(JSON.stringify(imageMap)),
		phases,
		passCount,
		failCount
	};
};

export const config = { maxDuration: 60 };
