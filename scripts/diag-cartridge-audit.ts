import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
const URI = process.env.MONGODB_URI!;

async function main() {
	await mongoose.connect(URI);
	const db = mongoose.connection.db!;

	console.log('=============================================================');
	console.log('CARTRIDGE / OVEN DASHBOARD AUDIT');
	console.log('=============================================================\n');

	// 1. Pipeline status distribution
	console.log('--- 1. CartridgeRecord status distribution ---');
	const statusAgg = await db.collection('cartridge_records').aggregate([
		{ $group: { _id: '$status', count: { $sum: 1 } } },
		{ $sort: { count: -1 } }
	]).toArray();
	let total = 0;
	for (const s of statusAgg) { console.log(`  ${s._id ?? '(null)'}: ${s.count}`); total += s.count; }
	console.log(`  TOTAL: ${total}\n`);

	// 2. Wax storage: status=wax_stored (what the dashboard counts)
	console.log('--- 2. Wax-stored cartridges (dashboard filter: status=wax_stored AND waxStorage.location) ---');
	const dashboardWax = await db.collection('cartridge_records').aggregate([
		{ $match: { 'waxStorage.location': { $exists: true }, status: 'wax_stored' } },
		{ $group: { _id: '$waxStorage.location', count: { $sum: 1 } } }
	]).toArray();
	let dashboardWaxTotal = 0;
	for (const s of dashboardWax) { console.log(`  ${s._id}: ${s.count}`); dashboardWaxTotal += s.count; }
	console.log(`  Dashboard wax-stored total: ${dashboardWaxTotal}\n`);

	// 3. Wax storage: ALL cartridges that have a waxStorage.location (any status)
	console.log('--- 3. ALL cartridges with waxStorage.location (any status) ---');
	const allWax = await db.collection('cartridge_records').aggregate([
		{ $match: { 'waxStorage.location': { $exists: true, $ne: null } } },
		{ $group: { _id: { loc: '$waxStorage.location', status: '$status' }, count: { $sum: 1 } } },
		{ $sort: { '_id.loc': 1, count: -1 } }
	]).toArray();
	const locRollup = new Map<string, number>();
	for (const s of allWax) {
		console.log(`  loc=${s._id.loc}  status=${s._id.status}  count=${s.count}`);
		locRollup.set(s._id.loc, (locRollup.get(s._id.loc) ?? 0) + s.count);
	}
	console.log('  Per-location totals (ignoring status):');
	for (const [loc, n] of locRollup) console.log(`    ${loc}: ${n}`);
	console.log('');

	// 4. Reagent-stored (dashboard filter)
	console.log('--- 4. Reagent-stored cartridges (dashboard filter: status=stored AND storage.fridgeName) ---');
	const dashboardRef = await db.collection('cartridge_records').aggregate([
		{ $match: { 'storage.fridgeName': { $exists: true }, status: 'stored' } },
		{ $group: { _id: '$storage.fridgeName', count: { $sum: 1 } } }
	]).toArray();
	for (const s of dashboardRef) console.log(`  ${s._id}: ${s.count}`);

	// 5. ALL cartridges with storage.fridgeName (any status)
	console.log('\n--- 5. ALL cartridges with storage.fridgeName (any status) ---');
	const allRef = await db.collection('cartridge_records').aggregate([
		{ $match: { 'storage.fridgeName': { $exists: true, $ne: null } } },
		{ $group: { _id: { loc: '$storage.fridgeName', status: '$status' }, count: { $sum: 1 } } },
		{ $sort: { '_id.loc': 1, count: -1 } }
	]).toArray();
	for (const s of allRef) console.log(`  loc=${s._id.loc}  status=${s._id.status}  count=${s.count}`);

	// 6. BACKING LOTS in ovens (this is where cured backing sheets live)
	console.log('\n--- 6. BackingLot occupancy (backing cartridges in ovens) ---');
	const backingLots = await db.collection('backing_lots').aggregate([
		{ $group: { _id: { status: '$status', oven: '$ovenLocationName' }, lots: { $sum: 1 }, totalCartridges: { $sum: '$cartridgeCount' } } },
		{ $sort: { '_id.status': 1 } }
	]).toArray();
	for (const s of backingLots) {
		console.log(`  status=${s._id.status}  oven=${s._id.oven ?? '(none)'}  lots=${s.lots}  cartridges=${s.totalCartridges}`);
	}

	// 7. BackingLot by ovenLocationId
	console.log('\n--- 7. BackingLot by ovenLocationId (used by equipment/activity page) ---');
	const backingByLoc = await db.collection('backing_lots').aggregate([
		{ $match: { status: { $in: ['in_oven', 'ready'] }, ovenLocationId: { $exists: true, $ne: null } } },
		{ $group: { _id: '$ovenLocationId', lots: { $sum: 1 }, cartridges: { $sum: '$cartridgeCount' } } }
	]).toArray();
	for (const s of backingByLoc) console.log(`  ovenLocationId=${s._id}  lots=${s.lots}  cartridges=${s.cartridges}`);

	// 8. WaxFillingRun in oven phase (post-fill, awaiting release from oven)
	console.log('\n--- 8. WaxFillingRun status breakdown ---');
	const waxRuns = await db.collection('wax_filling_runs').aggregate([
		{ $group: { _id: '$status', runs: { $sum: 1 }, cartridges: { $sum: '$plannedCartridgeCount' } } },
		{ $sort: { runs: -1 } }
	]).toArray();
	for (const s of waxRuns) console.log(`  status=${s._id}  runs=${s.runs}  cartridges(planned)=${s.cartridges ?? 0}`);

	// 9. WaxFillingRun currently sitting at an oven location (any status except abort)
	console.log('\n--- 9. WaxFillingRun with ovenLocationId set, by status ---');
	const waxInOven = await db.collection('wax_filling_runs').aggregate([
		{ $match: { ovenLocationId: { $exists: true, $ne: null } } },
		{ $group: { _id: { oven: '$ovenLocationId', status: '$status' }, runs: { $sum: 1 }, cartridges: { $sum: '$plannedCartridgeCount' } } },
		{ $sort: { '_id.oven': 1 } }
	]).toArray();
	for (const s of waxInOven) console.log(`  oven=${s._id.oven}  status=${s._id.status}  runs=${s.runs}  cartridges=${s.cartridges ?? 0}`);

	// 10. Equipment ovens — id → name
	console.log('\n--- 10. Equipment ovens ---');
	const ovens = await db.collection('equipment').find({ equipmentType: 'oven' }).toArray();
	for (const o of ovens as any[]) {
		console.log(`  _id=${o._id}  name="${o.name}"  barcode="${o.barcode}"  status=${o.status}  capacity=${o.capacity ?? '(none)'}`);
	}

	// 11. Equipment fridges
	console.log('\n--- 11. Equipment fridges ---');
	const fridges = await db.collection('equipment').find({ equipmentType: 'fridge' }).toArray();
	for (const f of fridges as any[]) {
		console.log(`  _id=${f._id}  name="${f.name}"  barcode="${f.barcode}"  status=${f.status}  capacity=${f.capacity ?? '(none)'}`);
	}

	// 12. ovenCure.locationId usage
	console.log('\n--- 12. CartridgeRecord ovenCure breakdown ---');
	const ovenCure = await db.collection('cartridge_records').aggregate([
		{ $match: { 'ovenCure.locationId': { $exists: true, $ne: null } } },
		{ $group: { _id: { loc: '$ovenCure.locationId', name: '$ovenCure.locationName', status: '$status' }, count: { $sum: 1 } } }
	]).toArray();
	for (const s of ovenCure) console.log(`  loc=${s._id.loc}  name=${s._id.name}  status=${s._id.status}  count=${s.count}`);

	console.log('\n=============================================================');
	console.log('DASHBOARD VS REALITY SUMMARY');
	console.log('=============================================================');
	console.log('Dashboard wax-stored total:  ' + dashboardWaxTotal);
	console.log('All waxStorage.location rows:' + Array.from(locRollup.values()).reduce((a, b) => a + b, 0));
	const ovenBacking = backingByLoc.reduce((s, x: any) => s + (x.cartridges ?? 0), 0);
	const ovenWaxRuns = waxInOven.filter((x: any) => !['completed','storage','Storage','aborted'].includes(x._id.status)).reduce((s, x: any) => s + (x.cartridges ?? 0), 0);
	console.log('Backing cartridges in ovens: ' + ovenBacking);
	console.log('Wax runs still in oven:      ' + ovenWaxRuns);

	await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
