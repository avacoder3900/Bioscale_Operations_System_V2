import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
const URI = process.env.MONGODB_URI!;

async function main() {
	await mongoose.connect(URI);
	const db = mongoose.connection.db!;

	// Find anything matching "fridge 001" naming
	console.log('=== Equipment / locations matching "fridge 001" ===');
	const eqs = await db.collection('equipment').find({
		$or: [
			{ name: /fridge.*001/i },
			{ name: /fridge.*1$/i },
			{ barcode: /FRG.?001/i },
			{ equipmentType: /fridge|refrigerator/i }
		]
	}).toArray();
	for (const e of eqs as any[]) {
		console.log(`  equipment _id=${e._id}  name="${e.name}"  type=${e.equipmentType}  barcode=${e.barcode}  status=${e.status}`);
	}

	const locs = await db.collection('equipment_locations').find({
		$or: [{ name: /fridge.*001/i }, { name: /fridge.*1$/i }]
	}).toArray();
	for (const l of locs as any[]) {
		console.log(`  location _id=${l._id}  name="${l.name}"`);
	}

	// Cartridges with any storage.* info
	console.log('\n=== CartridgeRecords with storage info ===');
	const withStorage = await db.collection('cartridge_records').find({
		$or: [
			{ 'storage.fridgeName': { $exists: true, $ne: null } },
			{ 'storage.locationId': { $exists: true, $ne: null } },
			{ status: 'stored' },
			{ status: 'refrigerated' }
		]
	}).project({ _id: 1, status: 1, storage: 1, 'reagentFilling.runId': 1 }).toArray();
	console.log(`Count: ${withStorage.length}`);
	const byFridge = new Map<string, any[]>();
	for (const c of withStorage as any[]) {
		const k = c.storage?.fridgeName ?? c.storage?.locationId ?? '(no fridge label)';
		if (!byFridge.has(k)) byFridge.set(k, []);
		byFridge.get(k)!.push(c);
	}
	for (const [k, arr] of byFridge) {
		const statuses = new Map<string, number>();
		for (const c of arr) statuses.set(c.status, (statuses.get(c.status) ?? 0) + 1);
		console.log(`  key="${k}"  count=${arr.length}  statuses: ${[...statuses.entries()].map(([s, n]) => `${s}=${n}`).join(', ')}`);
	}

	// Count stored/refrigerated regardless
	console.log('\n=== Raw counts ===');
	console.log(`  status=stored        : ${await db.collection('cartridge_records').countDocuments({ status: 'stored' })}`);
	console.log(`  status=refrigerated  : ${await db.collection('cartridge_records').countDocuments({ status: 'refrigerated' })}`);
	console.log(`  status=released      : ${await db.collection('cartridge_records').countDocuments({ status: 'released' })}`);

	// Pull detail on anything in fridge 001 specifically
	console.log('\n=== CartridgeRecords specifically in fridge 001 ===');
	const fridge001 = await db.collection('cartridge_records').find({
		$or: [
			{ 'storage.fridgeName': /001/i },
			{ 'storage.fridgeName': /fridge.*1$/i },
			{ 'storage.locationId': /001/i },
			{ 'storage.locationId': /FRG.?001/i }
		]
	}).toArray();
	console.log(`Found ${fridge001.length}`);
	for (const c of fridge001 as any[]) {
		console.log(`  _id=${c._id}  status=${c.status}  fridgeName=${c.storage?.fridgeName}  locationId=${c.storage?.locationId}  storedAt=${c.storage?.timestamp?.toISOString?.()}  operator=${c.storage?.operator?.username}`);
	}

	await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
