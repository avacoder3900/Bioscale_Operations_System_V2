/**
 * Migration: Normalize Equipment fridge/oven names and barcodes to match
 * the physical labels applied to the hardware.
 *
 * Target format (matches labels):
 *   Fridges: name = "Fridge N",  barcode = "FRIDGE-00N"
 *   Ovens:   name = "Oven N",    barcode = "OVEN-00N"
 *
 * Does NOT insert. Only updates existing Equipment docs with
 * equipmentType in ['fridge', 'oven'] whose name/barcode are not already
 * canonical. Child `equipment_locations` whose barcode starts with the
 * old parent barcode get their prefix swapped to the new barcode.
 *
 * Usage:
 *   npx tsx scripts/migrate-equipment-labels.ts            # dry-run (default)
 *   npx tsx scripts/migrate-equipment-labels.ts --apply    # commit changes
 */

import mongoose from 'mongoose';
import * as dotenv from 'dotenv';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
	console.error('MONGODB_URI env var not set');
	process.exit(1);
}

const APPLY = process.argv.includes('--apply');

type EquipType = 'fridge' | 'oven';

function canonical(type: EquipType, n: number) {
	const nameBase = type === 'fridge' ? 'Fridge' : 'Oven';
	const barcodeBase = type === 'fridge' ? 'FRIDGE' : 'OVEN';
	return {
		name: `${nameBase} ${n}`,
		barcode: `${barcodeBase}-${String(n).padStart(3, '0')}`
	};
}

function parseNumber(s: string | null | undefined): number | null {
	if (!s) return null;
	const m = String(s).match(/(\d+)/);
	return m ? parseInt(m[1], 10) : null;
}

async function main() {
	await mongoose.connect(MONGODB_URI!);
	const db = mongoose.connection.db!;
	const equipment = db.collection('equipment');
	const locations = db.collection('equipment_locations');
	const backingLots = db.collection('backing_lots');

	const docs = await equipment.find({ equipmentType: { $in: ['fridge', 'oven'] } }).toArray();
	console.log(`Found ${docs.length} existing fridge/oven Equipment doc(s).\n`);

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
		if (eq.name === canon.name && eq.barcode === canon.barcode) {
			continue; // already canonical — no-op
		}
		updates.push({
			_id: String(eq._id),
			type,
			before: { name: eq.name, barcode: eq.barcode },
			after: canon,
			oldBarcode: eq.barcode
		});
	}

	// Child location prefix swaps
	type ChildUpdate = { _id: string; before: string; after: string; parentId: string };
	const childUpdates: ChildUpdate[] = [];
	for (const u of updates) {
		if (!u.oldBarcode) continue;
		const children = await locations.find({ parentEquipmentId: u._id }).toArray();
		for (const c of children) {
			if (!c.barcode) continue;
			if (c.barcode.startsWith(u.oldBarcode)) {
				const newBc = u.after.barcode + String(c.barcode).slice(u.oldBarcode.length);
				if (newBc !== c.barcode) {
					childUpdates.push({ _id: String(c._id), before: c.barcode, after: newBc, parentId: u._id });
				}
			}
		}
	}

	// BackingLot snapshot refreshes — ovenLocationName is denormalized from
	// Equipment.name at scan time, so it stays stale after we rename. Find any
	// backing_lots whose ovenLocationId points at an Equipment we're renaming
	// and refresh the snapshot to the new name.
	type LotUpdate = { _id: string; ovenLocationId: string; before: string; after: string };
	const lotUpdates: LotUpdate[] = [];
	for (const u of updates) {
		if (u.before.name === u.after.name) continue; // name didn't change
		const lots = await backingLots.find({ ovenLocationId: u._id }).toArray();
		for (const l of lots) {
			if (l.ovenLocationName !== u.after.name) {
				lotUpdates.push({
					_id: String(l._id),
					ovenLocationId: u._id,
					before: l.ovenLocationName ?? '',
					after: u.after.name
				});
			}
		}
	}

	console.log(`Planned Equipment updates: ${updates.length}`);
	for (const u of updates) {
		console.log(`  [${u.type}] ${u._id}`);
		console.log(`    name:    "${u.before.name ?? ''}" → "${u.after.name}"`);
		console.log(`    barcode: "${u.before.barcode ?? ''}" → "${u.after.barcode}"`);
	}
	console.log(`\nPlanned child equipment_locations updates: ${childUpdates.length}`);
	for (const c of childUpdates) {
		console.log(`  ${c._id}  "${c.before}" → "${c.after}"`);
	}
	console.log(`\nPlanned backing_lot snapshot refreshes: ${lotUpdates.length}`);
	for (const l of lotUpdates) {
		console.log(`  ${l._id}  ovenLocationName: "${l.before}" → "${l.after}"`);
	}
	if (skipped.length > 0) {
		console.log(`\nSkipped ${skipped.length} doc(s):`);
		for (const s of skipped) console.log(`  ${s._id} — ${s.reason}`);
	}

	if (updates.length === 0 && childUpdates.length === 0 && lotUpdates.length === 0) {
		console.log('\n✓ Nothing to update — already canonical.');
		await mongoose.disconnect();
		return;
	}

	if (!APPLY) {
		console.log('\n(Dry run — re-run with --apply to commit.)');
		await mongoose.disconnect();
		return;
	}

	console.log('\nApplying...');
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
	let lotOk = 0;
	for (const l of lotUpdates) {
		const res = await backingLots.updateOne(
			{ _id: l._id },
			{ $set: { ovenLocationName: l.after, updatedAt: new Date() } }
		);
		if (res.modifiedCount) lotOk++;
	}
	console.log(`✓ Equipment updated: ${equipOk}/${updates.length}`);
	console.log(`✓ Child locations updated: ${childOk}/${childUpdates.length}`);
	console.log(`✓ BackingLot snapshots refreshed: ${lotOk}/${lotUpdates.length}`);

	await mongoose.disconnect();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
