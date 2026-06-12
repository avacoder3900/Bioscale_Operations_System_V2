/**
 * Save / clear the deck-barcode position of a position set (OT2-BRIDGE-2).
 * PUT    /api/scanner-position-sets/:id/deck-position
 *   { x: number, y: number, z: number, testScanBarcode?: string }
 * DELETE /api/scanner-position-sets/:id/deck-position
 *
 * The deck-barcode position is where the gantry scanner can read the deck's
 * own barcode label. Taught once per robot on the scanner-positions teach
 * page (same jog → save → optional test-scan flow as the slot grid) and
 * consumed by POST /api/scanner/deck-scan.
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, OpentronsScannerPositionSet, AuditLog, generateId } from '$lib/server/db';

// split:true gives this dynamic-segment endpoint its own Vercel function instead
// of a symlink into the merged group, working around a Vercel deploy-time bug that
// 404s bracketed API routes at the edge before they reach our code.
export const config = { split: true };

export const PUT: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:write');

	const body = await request.json().catch(() => ({} as any));
	const x = body?.x;
	const y = body?.y;
	const z = body?.z;
	const testScanBarcode = body?.testScanBarcode?.toString() || undefined;

	if (typeof x !== 'number' || !Number.isFinite(x)) error(400, 'x must be a finite number');
	if (typeof y !== 'number' || !Number.isFinite(y)) error(400, 'y must be a finite number');
	if (typeof z !== 'number' || !Number.isFinite(z)) error(400, 'z must be a finite number');

	await connectDB();
	const existing = await OpentronsScannerPositionSet.findById(params.id);
	if (!existing) error(404, 'Position set not found');

	const now = new Date();
	const oldEntry = existing.deckBarcodePosition ?? null;

	await OpentronsScannerPositionSet.updateOne(
		{ _id: params.id },
		{
			$set: {
				'deckBarcodePosition.x': x,
				'deckBarcodePosition.y': y,
				'deckBarcodePosition.z': z,
				...(testScanBarcode !== undefined
					? {
							'deckBarcodePosition.testScanBarcode': testScanBarcode,
							'deckBarcodePosition.testScannedAt': now
						}
					: {}),
				updatedBy: { _id: locals.user._id, username: locals.user.username }
			}
		}
	);

	await AuditLog.create({
		_id: generateId(),
		tableName: 'opentrons_scanner_position_sets',
		recordId: params.id,
		action: 'save_deck_position',
		oldData: oldEntry ? JSON.parse(JSON.stringify(oldEntry)) : null,
		newData: { x, y, z, testScanBarcode },
		changedAt: now,
		changedBy: locals.user.username
	});

	const updated = await OpentronsScannerPositionSet.findById(params.id).lean();
	return json(JSON.parse(JSON.stringify(updated)));
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:write');

	await connectDB();
	const existing = await OpentronsScannerPositionSet.findById(params.id);
	if (!existing) error(404, 'Position set not found');

	const oldEntry = existing.deckBarcodePosition ?? null;

	await OpentronsScannerPositionSet.updateOne(
		{ _id: params.id },
		{
			$unset: { deckBarcodePosition: 1 },
			$set: { updatedBy: { _id: locals.user._id, username: locals.user.username } }
		}
	);

	await AuditLog.create({
		_id: generateId(),
		tableName: 'opentrons_scanner_position_sets',
		recordId: params.id,
		action: 'clear_deck_position',
		oldData: oldEntry ? JSON.parse(JSON.stringify(oldEntry)) : null,
		changedAt: new Date(),
		changedBy: locals.user.username
	});

	return json({ ok: true });
};
