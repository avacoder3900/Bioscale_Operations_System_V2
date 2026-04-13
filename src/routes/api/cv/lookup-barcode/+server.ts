/**
 * GET /api/cv/lookup-barcode?code=CART-000123
 *
 * Looks up a scanned barcode/QR code against BIMS records.
 * Checks: CartridgeRecord, LotRecord, PartDefinition
 */
import { json, error } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');

	const code = url.searchParams.get('code')?.trim();
	if (!code) return json({ error: 'code parameter is required' }, { status: 400 });

	await connectDB();
	const { connection } = await import('mongoose');
	const db = connection.db;
	if (!db) return json({ error: 'Database not available' }, { status: 500 });

	// Try CartridgeRecord first (most common on manufacturing floor)
	const cartridge = await db.collection('cartridge_records').findOne({
		$or: [{ barcode: code }, { _id: code }]
	});
	if (cartridge) {
		return json({
			type: 'cartridge',
			_id: cartridge._id,
			barcode: cartridge.barcode,
			phase: cartridge.currentPhase || cartridge.status,
			lotNumber: cartridge.lotNumber,
			assayName: cartridge.assayName
		});
	}

	// Try LotRecord
	const lot = await db.collection('lot_records').findOne({
		$or: [{ lotNumber: code }, { _id: code }, { qrCodeRef: code }]
	});
	if (lot) {
		return json({
			type: 'lot',
			_id: lot._id,
			lotNumber: lot.lotNumber,
			status: lot.status,
			assayName: lot.assayName
		});
	}

	// Try PartDefinition
	const part = await db.collection('part_definitions').findOne({
		$or: [{ barcode: code }, { _id: code }, { partNumber: code }]
	});
	if (part) {
		return json({
			type: 'part',
			_id: part._id,
			barcode: part.barcode,
			name: part.name,
			partNumber: part.partNumber
		});
	}

	return json({ type: 'unknown', raw: code });
};
