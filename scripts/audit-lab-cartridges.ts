/**
 * Read-only audit: what actually lives in lab_cartridges vs cartridge_records?
 * Question we're answering: is LabCartridge a real concept with data, or
 * sloppy/dead code that duplicates CartridgeRecord?
 *
 * Does not write anything.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) { console.error('MONGODB_URI env var not set'); process.exit(1); }

async function main() {
	await mongoose.connect(MONGODB_URI as string);
	const db = mongoose.connection.db!;

	const lab = db.collection('lab_cartridges');
	const rec = db.collection('cartridge_records');

	const grp = db.collection('cartridge_groups');
	const fw = db.collection('firmware_cartridges');
	const [labCount, recCount, grpCount, fwCount] = await Promise.all([
		lab.countDocuments(),
		rec.countDocuments(),
		grp.countDocuments(),
		fw.countDocuments()
	]);

	console.log('=== COUNTS ===');
	console.log(`lab_cartridges:        ${labCount}`);
	console.log(`cartridge_records:     ${recCount}`);
	console.log(`cartridge_groups:      ${grpCount}`);
	console.log(`firmware_cartridges:   ${fwCount}`);
	console.log();

	if (labCount === 0) {
		console.log('lab_cartridges is EMPTY — clearly dead code.');
		await mongoose.disconnect();
		return;
	}

	// Status breakdown
	const labStatus = await lab.aggregate([
		{ $group: { _id: '$status', count: { $sum: 1 } } },
		{ $sort: { count: -1 } }
	]).toArray();
	console.log('=== lab_cartridges by status ===');
	for (const s of labStatus) console.log(`  ${s._id ?? '(null)'}: ${s.count}`);
	console.log();

	// Type breakdown
	const labType = await lab.aggregate([
		{ $group: { _id: '$cartridgeType', count: { $sum: 1 } } },
		{ $sort: { count: -1 } }
	]).toArray();
	console.log('=== lab_cartridges by cartridgeType ===');
	for (const t of labType) console.log(`  ${t._id ?? '(null)'}: ${t.count}`);
	console.log();

	// Created timeline
	const oldest = await lab.find({}).sort({ createdAt: 1 }).limit(1).toArray();
	const newest = await lab.find({}).sort({ createdAt: -1 }).limit(1).toArray();
	console.log('=== lab_cartridges timeline ===');
	console.log(`  Oldest: ${oldest[0]?.createdAt ?? '(no createdAt)'} _id=${oldest[0]?._id}`);
	console.log(`  Newest: ${newest[0]?.createdAt ?? '(no createdAt)'} _id=${newest[0]?._id}`);
	console.log();

	// Active activity in last 30/90 days
	const now = Date.now();
	const day30 = new Date(now - 30 * 86_400_000);
	const day90 = new Date(now - 90 * 86_400_000);
	const [recent30, recent90] = await Promise.all([
		lab.countDocuments({ updatedAt: { $gte: day30 } }),
		lab.countDocuments({ updatedAt: { $gte: day90 } })
	]);
	console.log('=== lab_cartridges activity ===');
	console.log(`  Updated in last 30 days: ${recent30}`);
	console.log(`  Updated in last 90 days: ${recent90}`);
	console.log();

	// Sample 5 documents — show the actual shape
	const sample = await lab.find({}).limit(5).toArray();
	console.log('=== Sample lab_cartridges documents (5) ===');
	for (const doc of sample) {
		console.log(`  _id=${doc._id}`);
		console.log(`    barcode:         ${doc.barcode}`);
		console.log(`    cartridgeType:   ${doc.cartridgeType}`);
		console.log(`    status:          ${doc.status}`);
		console.log(`    lotNumber:       ${doc.lotNumber}`);
		console.log(`    manufacturer:    ${doc.manufacturer}`);
		console.log(`    usageLog count:  ${doc.usageLog?.length ?? 0}`);
		console.log(`    createdAt:       ${doc.createdAt}`);
		console.log(`    updatedAt:       ${doc.updatedAt}`);
		console.log();
	}

	// Cross-collection overlap: do any LabCartridge barcodes match CartridgeRecord._ids?
	const barcodes = (await lab.find({ barcode: { $exists: true, $ne: null } })
		.project({ _id: 1, barcode: 1 }).toArray())
		.filter(d => typeof d.barcode === 'string' && d.barcode.length > 0);

	console.log(`=== Cross-collection check: ${barcodes.length} lab_cartridges have barcodes ===`);
	if (barcodes.length > 0) {
		const barcodeList = barcodes.map(d => d.barcode).slice(0, 5000);
		const matches = await rec.countDocuments({ _id: { $in: barcodeList } });
		console.log(`  LabCartridge.barcode values that ALSO exist as CartridgeRecord._id: ${matches} / ${barcodeList.length}`);
		// Show 3 example matches
		const exampleMatches = await rec.find({ _id: { $in: barcodeList.slice(0, 50) } })
			.project({ _id: 1, status: 1, createdAt: 1 })
			.limit(3)
			.toArray();
		if (exampleMatches.length > 0) {
			console.log(`  Example matches:`);
			for (const m of exampleMatches) {
				console.log(`    ${m._id}  rec.status=${m.status}  rec.createdAt=${m.createdAt}`);
			}
		}
	}
	console.log();

	// Any non-null usageLog entries? = real human activity vs zombie data
	const withActivity = await lab.countDocuments({ 'usageLog.0': { $exists: true } });
	console.log(`=== Real usage: lab_cartridges with any usageLog entries: ${withActivity} ===`);

	await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
