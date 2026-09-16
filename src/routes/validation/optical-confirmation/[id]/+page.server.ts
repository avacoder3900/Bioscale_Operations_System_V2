import { error } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, CartridgeRecord } from '$lib/server/db';
import { analyzeCartridge, analyzePhotobleach } from '$lib/server/optical-analysis';
import { opticalKindFor } from '$lib/server/optical-constants';
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
	const readings = (cartridge as any)?.rawData?.readings ?? [];
	const analysis = analyzeCartridge(readings);
	// A photobleach run is 10 sweeps of one cartridge: read as one point per
	// channel per sweep, never pooled.
	const kind = opticalKindFor((cartridge as any)?.assayId);
	const photobleach = kind === 'photobleach' ? analyzePhotobleach(readings) : null;

	return {
		cartridge: JSON.parse(JSON.stringify(cartridge)),
		analysis,
		kind,
		photobleach
	};
};
