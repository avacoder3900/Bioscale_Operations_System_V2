/**
 * POST /api/cv/induct-cartridge
 *
 * Creates a new cartridge_record from a scanned QR code.
 * Used when "Induct Mode" is enabled on the CV capture page
 * and the scanned QR doesn't match an existing cartridge.
 */
import { json, error } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CartridgeRecord } from '$lib/server/db/models/cartridge-record.js';
import { AuditLog } from '$lib/server/db/models/audit-log.js';
import { generateId } from '$lib/server/db/utils.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	const { cartridgeId } = await request.json();
	if (!cartridgeId || typeof cartridgeId !== 'string') {
		return json({ error: 'cartridgeId is required' }, { status: 400 });
	}

	// Check if it already exists
	const existing = await CartridgeRecord.findById(cartridgeId).select('_id').lean();
	if (existing) {
		return json({ error: 'Cartridge already exists', _id: cartridgeId }, { status: 409 });
	}

	const now = new Date();
	const cartridge = await CartridgeRecord.create({
		_id: cartridgeId,
		status: 'wax_filled',
		backing: {
			operator: { _id: locals.user._id, username: locals.user.username },
			recordedAt: now
		},
		photos: []
	});

	await AuditLog.create({
		_id: generateId(),
		action: 'create',
		resourceType: 'cartridge_record',
		resourceId: cartridgeId,
		userId: locals.user._id,
		username: locals.user.username,
		timestamp: now,
		details: { source: 'cv_induct', status: 'wax_filled' }
	});

	return json({
		_id: cartridge._id,
		status: 'wax_filled',
		message: 'Cartridge inducted into system'
	}, { status: 201 });
};
