/**
 * One-off read-only scan: find every place the string "Heater" appears in
 * equipment-adjacent collections. Pure diagnostics — does not write.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
	console.error('MONGODB_URI env var not set');
	process.exit(1);
}

async function main() {
	await mongoose.connect(MONGODB_URI!);
	const db = mongoose.connection.db!;

	const rx = /heater/i;

	console.log('=== equipment (name/barcode matching /heater/i) ===');
	const eq = await db.collection('equipment').find({
		$or: [{ name: rx }, { barcode: rx }]
	}).project({ _id: 1, name: 1, barcode: 1, equipmentType: 1, status: 1 }).toArray();
	console.log(JSON.stringify(eq, null, 2));

	console.log('\n=== equipment_locations (barcode/displayName matching /heater/i) ===');
	const locs = await db.collection('equipment_locations').find({
		$or: [{ displayName: rx }, { barcode: rx }]
	}).project({ _id: 1, displayName: 1, barcode: 1, parentEquipmentId: 1, locationType: 1 }).toArray();
	console.log(JSON.stringify(locs, null, 2));

	console.log('\n=== backing_lots (ovenLocationName matching /heater/i) ===');
	const bl = await db.collection('backing_lots').find({
		ovenLocationName: rx
	}).project({ _id: 1, ovenLocationName: 1, ovenLocationId: 1, status: 1, cartridgeCount: 1 }).toArray();
	console.log(JSON.stringify(bl, null, 2));

	console.log('\n=== lot_records (ovenPlacement.ovenBarcode matching /heater/i) ===');
	const lr = await db.collection('lot_records').find({
		'ovenPlacement.ovenBarcode': rx
	}).project({ _id: 1, ovenPlacement: 1 }).toArray();
	console.log(JSON.stringify(lr, null, 2));

	// Cartridge records: check ovenCure.locationName and storage.fridgeName just in case
	console.log('\n=== cartridge_records (ovenCure.locationName matching /heater/i) ===');
	const cr = await db.collection('cartridge_records').find({
		'ovenCure.locationName': rx
	}).project({ _id: 1, 'ovenCure.locationName': 1, 'ovenCure.locationId': 1 }).toArray();
	console.log(JSON.stringify(cr, null, 2));

	await mongoose.disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
