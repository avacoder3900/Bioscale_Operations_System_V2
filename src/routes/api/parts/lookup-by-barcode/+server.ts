import { json, error } from '@sveltejs/kit';
import { connectDB, PartDefinition } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) {
		throw error(401, 'Unauthorized');
	}

	const barcode = url.searchParams.get('barcode')?.trim();
	if (!barcode) {
		return json({ error: 'barcode query parameter is required' }, { status: 400 });
	}

	await connectDB();

	const part = await PartDefinition.findOne({ barcode, isActive: true }).lean() as any;

	if (!part) {
		return json({ found: false }, { status: 404 });
	}

	return json({
		found: true,
		id: part._id,
		partNumber: part.partNumber ?? '',
		name: part.name ?? '',
		category: part.category ?? null,
		barcode: part.barcode,
		inventoryCount: part.inventoryCount ?? 0
	});
};
