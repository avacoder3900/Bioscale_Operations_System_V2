import { error } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, CartridgeRecord } from '$lib/server/db';
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

	return {
		barcode: params.id,
		metrics: computeMetrics(cartridge),
		cartridge: JSON.parse(JSON.stringify(cartridge))
	};
};

// The "analyze" computation from the research workflow: sum the F3 and F7
// fluorometer channels across every reading, then the F7/F3 ratio. Returns null
// counts when there's no run data so the view can show an empty state.
function computeMetrics(cartridge: any): {
	readingCount: number;
	f3Sum: number | null;
	f7Sum: number | null;
	ratio: number | null;
} {
	const readings: any[] = Array.isArray(cartridge?.rawData?.readings)
		? cartridge.rawData.readings
		: [];

	if (readings.length === 0) {
		return { readingCount: 0, f3Sum: null, f7Sum: null, ratio: null };
	}

	let f3Sum = 0;
	let f7Sum = 0;
	for (const r of readings) {
		if (typeof r?.f3 === 'number') f3Sum += r.f3;
		if (typeof r?.f7 === 'number') f7Sum += r.f7;
	}

	const ratio = f3Sum !== 0 ? f7Sum / f3Sum : null;
	return { readingCount: readings.length, f3Sum, f7Sum, ratio };
}
