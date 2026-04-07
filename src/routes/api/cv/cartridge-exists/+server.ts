/**
 * GET /api/cv/cartridge-exists?id=CART-000123
 *
 * Quick check: does this cartridge exist in the database?
 * Returns existence, status, and photo count for instant CV label feedback.
 */
import { json } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CartridgeRecord } from '$lib/server/db/models/cartridge-record.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });

	const id = url.searchParams.get('id')?.trim();
	if (!id) return json({ error: 'id parameter is required' }, { status: 400 });

	await connectDB();

	const cartridge = await CartridgeRecord.findById(id)
		.select('_id status photos')
		.lean() as any;

	if (!cartridge) {
		return json({ exists: false, status: null, photoCount: 0 });
	}

	return json({
		exists: true,
		status: cartridge.status ?? 'unknown',
		photoCount: cartridge.photos?.length ?? 0
	});
};
