/**
 * Save a single slot's XYZ in a position set.
 * PUT /api/scanner-position-sets/:id/positions/:slotIndex
 *   { x: number, y: number, z: number, testScanBarcode?: string }
 *
 * Upserts the slot inside the positions[] subdoc array. The set's positions
 * array can be sparse during teach — sweep at run time skips any slot whose
 * XYZ hasn't been saved yet (returns an error so the operator knows).
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, OpentronsScannerPositionSet, AuditLog, generateId } from '$lib/server/db';

export const PUT: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:write');

	const slotIndex = Number(params.slotIndex);
	if (!Number.isInteger(slotIndex) || slotIndex < 0) error(400, 'slotIndex must be a non-negative integer');

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
	if (slotIndex >= existing.positionCount)
		error(400, `slotIndex ${slotIndex} is out of range (positionCount=${existing.positionCount})`);

	const now = new Date();
	const idx = (existing.positions ?? []).findIndex((p: any) => p.slotIndex === slotIndex);
	const oldEntry = idx >= 0 ? existing.positions[idx] : null;

	if (idx >= 0) {
		await OpentronsScannerPositionSet.updateOne(
			{ _id: params.id, 'positions.slotIndex': slotIndex },
			{
				$set: {
					'positions.$.x': x,
					'positions.$.y': y,
					'positions.$.z': z,
					...(testScanBarcode !== undefined
						? { 'positions.$.testScanBarcode': testScanBarcode, 'positions.$.testScannedAt': now }
						: {}),
					updatedBy: { _id: locals.user._id, username: locals.user.username }
				}
			}
		);
	} else {
		await OpentronsScannerPositionSet.updateOne(
			{ _id: params.id },
			{
				$push: {
					positions: {
						slotIndex,
						x,
						y,
						z,
						...(testScanBarcode !== undefined ? { testScanBarcode, testScannedAt: now } : {})
					}
				},
				$set: { updatedBy: { _id: locals.user._id, username: locals.user.username } }
			}
		);
	}

	await AuditLog.create({
		_id: generateId(),
		tableName: 'opentrons_scanner_position_sets',
		recordId: params.id,
		action: 'save_position',
		oldData: oldEntry ? JSON.parse(JSON.stringify(oldEntry)) : null,
		newData: { slotIndex, x, y, z, testScanBarcode },
		changedAt: now,
		changedBy: locals.user.username
	});

	const updated = await OpentronsScannerPositionSet.findById(params.id).lean();
	return json(JSON.parse(JSON.stringify(updated)));
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:write');

	const slotIndex = Number(params.slotIndex);
	if (!Number.isInteger(slotIndex) || slotIndex < 0) error(400, 'slotIndex must be a non-negative integer');

	await connectDB();
	const existing = await OpentronsScannerPositionSet.findById(params.id);
	if (!existing) error(404, 'Position set not found');

	await OpentronsScannerPositionSet.updateOne(
		{ _id: params.id },
		{
			$pull: { positions: { slotIndex } },
			$set: { updatedBy: { _id: locals.user._id, username: locals.user.username } }
		}
	);

	await AuditLog.create({
		_id: generateId(),
		tableName: 'opentrons_scanner_position_sets',
		recordId: params.id,
		action: 'clear_position',
		oldData: { slotIndex },
		changedAt: new Date(),
		changedBy: locals.user.username
	});

	return json({ ok: true });
};
