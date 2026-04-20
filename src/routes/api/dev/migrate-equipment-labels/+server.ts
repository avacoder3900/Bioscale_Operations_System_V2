/**
 * Admin-only endpoint to normalize Equipment (fridge/oven) names and barcodes
 * to match the physical labels.
 *
 * Target format:
 *   Fridges: name = "Fridge N",  barcode = "FRIDGE-00N"
 *   Ovens:   name = "Oven N",    barcode = "OVEN-00N"
 *
 * GET  /api/dev/migrate-equipment-labels          -> dry-run; returns planned changes
 * POST /api/dev/migrate-equipment-labels?apply=1  -> commit changes (admin only)
 *
 * Never inserts. Only updates existing Equipment docs. Child equipment_locations
 * whose barcode starts with the old parent barcode get their prefix swapped.
 */
import { json } from '@sveltejs/kit';
import mongoose from 'mongoose';
import { connectDB } from '$lib/server/db';
import { isAdmin } from '$lib/server/permissions';
import type { RequestHandler } from './$types';

type EquipType = 'fridge' | 'oven';

function canonical(type: EquipType, n: number) {
	const nameBase = type === 'fridge' ? 'Fridge' : 'Oven';
	const barcodeBase = type === 'fridge' ? 'FRIDGE' : 'OVEN';
	return {
		name: `${nameBase} ${n}`,
		barcode: `${barcodeBase}-${String(n).padStart(3, '0')}`
	};
}

function parseNumber(s: unknown): number | null {
	if (!s) return null;
	const m = String(s).match(/(\d+)/);
	return m ? parseInt(m[1], 10) : null;
}

async function plan() {
	await connectDB();
	const db = mongoose.connection.db!;
	const equipment = db.collection('equipment');
	const locations = db.collection('equipment_locations');

	const docs = await equipment.find({ equipmentType: { $in: ['fridge', 'oven'] } }).toArray();

	type Update = {
		_id: string;
		type: EquipType;
		before: { name?: string; barcode?: string };
		after: { name: string; barcode: string };
		oldBarcode: string | undefined;
	};
	const updates: Update[] = [];
	const skipped: { _id: string; reason: string }[] = [];

	for (const eq of docs) {
		const type = eq.equipmentType as EquipType;
		const n = parseNumber(eq.name) ?? parseNumber(eq.barcode);
		if (n == null) {
			skipped.push({ _id: String(eq._id), reason: `cannot parse number from name="${eq.name}" barcode="${eq.barcode}"` });
			continue;
		}
		const canon = canonical(type, n);
		if (eq.name === canon.name && eq.barcode === canon.barcode) continue;
		updates.push({
			_id: String(eq._id),
			type,
			before: { name: eq.name, barcode: eq.barcode },
			after: canon,
			oldBarcode: eq.barcode
		});
	}

	type ChildUpdate = { _id: string; parentId: string; before: string; after: string };
	const childUpdates: ChildUpdate[] = [];
	for (const u of updates) {
		if (!u.oldBarcode) continue;
		const children = await locations.find({ parentEquipmentId: u._id }).toArray();
		for (const c of children) {
			if (!c.barcode) continue;
			if (String(c.barcode).startsWith(u.oldBarcode)) {
				const newBc = u.after.barcode + String(c.barcode).slice(u.oldBarcode.length);
				if (newBc !== c.barcode) {
					childUpdates.push({ _id: String(c._id), parentId: u._id, before: c.barcode, after: newBc });
				}
			}
		}
	}

	return { totalDocs: docs.length, updates, childUpdates, skipped };
}

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	if (!isAdmin(locals.user)) return json({ error: 'Admin access required' }, { status: 403 });

	const { totalDocs, updates, childUpdates, skipped } = await plan();
	return json({
		dryRun: true,
		totalDocs,
		equipmentUpdates: updates.length,
		childLocationUpdates: childUpdates.length,
		skipped: skipped.length,
		plan: { updates, childUpdates, skipped }
	});
};

export const POST: RequestHandler = async ({ locals, url }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	if (!isAdmin(locals.user)) return json({ error: 'Admin access required' }, { status: 403 });

	const apply = url.searchParams.get('apply') === '1';
	const { totalDocs, updates, childUpdates, skipped } = await plan();

	if (!apply) {
		return json({
			dryRun: true,
			totalDocs,
			equipmentUpdates: updates.length,
			childLocationUpdates: childUpdates.length,
			skipped: skipped.length,
			plan: { updates, childUpdates, skipped },
			note: 'No changes made. Re-POST with ?apply=1 to commit.'
		});
	}

	const db = mongoose.connection.db!;
	const equipment = db.collection('equipment');
	const locations = db.collection('equipment_locations');

	let equipOk = 0;
	for (const u of updates) {
		const res = await equipment.updateOne(
			{ _id: u._id },
			{ $set: { name: u.after.name, barcode: u.after.barcode, updatedAt: new Date() } }
		);
		if (res.modifiedCount) equipOk++;
	}
	let childOk = 0;
	for (const c of childUpdates) {
		const res = await locations.updateOne(
			{ _id: c._id },
			{ $set: { barcode: c.after, updatedAt: new Date() } }
		);
		if (res.modifiedCount) childOk++;
	}

	return json({
		applied: true,
		totalDocs,
		equipmentUpdated: equipOk,
		equipmentPlanned: updates.length,
		childLocationsUpdated: childOk,
		childLocationsPlanned: childUpdates.length,
		skipped: skipped.length,
		plan: { updates, childUpdates, skipped }
	});
};
