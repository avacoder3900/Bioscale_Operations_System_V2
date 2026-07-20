import { error } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, CartridgeRecord } from '$lib/server/db';
import { computeOpticalAnalysis } from '$lib/server/optical-analysis';
import type { PageServerLoad } from './$types';

// Cartridge data view — the "analyze" / view-the-data pathway ported from the
// research app. The cartridge_records `_id` IS the scanned barcode, so the
// barcode in the optical log links straight here.
export const load: PageServerLoad = async ({ params, locals }) => {
	requirePermission(locals.user, 'cartridge:read');
	await connectDB();

	const cartridge = await CartridgeRecord.findById(params.id).lean();
	if (!cartridge) {
		throw error(404, `Cartridge ${params.id} not found`);
	}

	// Derive-on-read per-channel F7/F3 analysis (the "Single Scan Cortisol"
	// profile). Non-destructive: computed from rawData.readings, never written back.
	const analysis = computeOpticalAnalysis((cartridge as any)?.rawData?.readings ?? []);

	return {
		cartridge: JSON.parse(JSON.stringify(cartridge)),
		analysis
	};
};
