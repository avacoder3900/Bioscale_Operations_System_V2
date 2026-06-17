/**
 * Run every occupancy query used across the site, side-by-side, so we can verify
 * that all pages agree. If two numbers disagree, one of the pages is lying.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;

	const equip = await db.collection('equipment').find({
		equipmentType: { $in: ['fridge', 'oven'] }
	}).sort({ equipmentType: 1, name: 1 }).toArray();

	console.log('                                                  dashboard   activity   location/[id]');
	console.log('Equipment                                 type    wax+reag    wax+reag   total       ');
	console.log('---------------------------------------------------------------------------------------');

	for (const e of equip as any[]) {
		const id = String(e._id);
		const name = e.name ?? '';
		const barcode = e.barcode ?? '';
		const keys = [id, barcode, name].filter(Boolean);

		// Query 1: dashboard / fridges-ovens / cartridge-dashboard style
		const waxDash = await db.collection('cartridge_records').countDocuments({
			'waxStorage.location': { $in: keys }, status: 'wax_stored'
		});
		const reagentDash = await db.collection('cartridge_records').countDocuments({
			'storage.fridgeName': { $in: keys }, status: 'stored'
		});

		// Query 2: activity page (includes reagent_filled)
		const reagentActivity = await db.collection('cartridge_records').countDocuments({
			'storage.fridgeName': { $in: keys }, status: { $in: ['stored', 'reagent_filled'] }
		});

		// Query 3: oven specifically — sum BackingLot.cartridgeCount
		let ovenCount = 0;
		if (e.equipmentType === 'oven') {
			const agg = await db.collection('backing_lots').aggregate([
				{ $match: { ovenLocationId: id, status: { $in: ['in_oven', 'ready'] } } },
				{ $group: { _id: null, total: { $sum: '$cartridgeCount' } } }
			]).toArray();
			ovenCount = (agg[0] as any)?.total ?? 0;
		}

		// Query 4: location page style — $or wax OR fridgeName, no status filter at all
		const locRaw = await db.collection('cartridge_records').countDocuments({
			$or: [
				{ 'waxStorage.location': { $in: keys } },
				{ 'storage.fridgeName': { $in: keys } }
			]
		});

		const displayDash = e.equipmentType === 'oven' ? `oven:${ovenCount}` : `${waxDash + reagentDash}`;
		const displayAct = e.equipmentType === 'oven' ? `oven:${ovenCount}` : `${waxDash + reagentActivity}`;
		const label = `${name.padEnd(12)} (${barcode.padEnd(10)}) ${e.equipmentType.padEnd(6)}`;
		console.log(`${label}  ${String(displayDash).padEnd(10)}  ${String(displayAct).padEnd(9)}  loc-all:${locRaw}`);
	}

	console.log('');
	console.log('Legend:');
	console.log('  dashboard = what /cartridge-dashboard and /equipment/fridges-ovens now show');
	console.log('  activity  = what /equipment/activity shows (includes reagent_filled in fridge)');
	console.log('  loc-all   = what /equipment/location/[id] shows (NO status filter — includes ghosts)');

	await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
