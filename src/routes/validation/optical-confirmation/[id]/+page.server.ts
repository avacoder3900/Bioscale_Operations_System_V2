import { error } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, CartridgeRecord } from '$lib/server/db';
import { computeOpticalAnalysis } from '$lib/server/optical-analysis';
import type { PageServerLoad } from './$types';

// Per-cartridge optical data view: raw readings + the research-app analysis
// (per-channel F7/F3 of summed bands). cartridge_records `_id` IS the scanned
// barcode, so the barcode in the optical log links straight here.
export const load: PageServerLoad = async ({ params, locals }) => {
	requirePermission(locals.user, 'cartridge:read');
	await connectDB();

	const cartridge = await CartridgeRecord.findById(params.id).lean() as any;
	if (!cartridge) {
		throw error(404, `Cartridge ${params.id} not found`);
	}

	const readings: any[] = Array.isArray(cartridge?.rawData?.readings)
		? cartridge.rawData.readings
		: [];

	return {
		barcode: params.id,
		assayName: cartridge.assayName ?? cartridge.assayId ?? null,
		status: cartridge.status ?? 'linked',
		spuUdi: cartridge.device?.name ?? null,
		completedAt: cartridge.checkpoints?.completed?.when ?? null,
		analysis: computeOpticalAnalysis(cartridge),
		readings: JSON.parse(JSON.stringify(readings)),
		rawData: JSON.parse(JSON.stringify(cartridge.rawData ?? null))
	};
};
