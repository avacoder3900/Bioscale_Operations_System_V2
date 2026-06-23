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
		cartridge: JSON.parse(JSON.stringify(cartridge))
	};
};
