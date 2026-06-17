import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
const URI = process.env.MONGODB_URI!;

async function main() {
	await mongoose.connect(URI);
	const db = mongoose.connection.db!;

	// WI-01 creates CartridgeRecord{status:'backing', backing.lotId=LotRecord._id}
	// LotRecord.bucketBarcode = BackingLot._id.
	// So for each BackingLot.status==='consumed', find its LotRecord via bucketBarcode,
	// and count the stub cartridges still sitting at status='backing' for that LotRecord.

	const consumedLots = await db.collection('backing_lots').find({ status: 'consumed' }).toArray();
	const openLots = await db.collection('backing_lots').find({ status: { $in: ['in_oven', 'ready'] } }).toArray();

	console.log('=== Consumed BackingLots → matching LotRecord → placeholders still status=backing ===');
	let placeholderTotal = 0;
	for (const bl of consumedLots as any[]) {
		const lotRec = await db.collection('lot_records').findOne({ bucketBarcode: bl._id });
		if (!lotRec) { console.log(`  BL=${bl._id}  no LotRecord found`); continue; }
		const stubCount = await db.collection('cartridge_records').countDocuments({
			'backing.lotId': lotRec._id,
			status: 'backing'
		});
		placeholderTotal += stubCount;
		console.log(`  BL=${bl._id}  LotRecord=${lotRec._id}  stubsStillBacking=${stubCount}`);
	}
	console.log(`  Placeholders to void (consumed): ${placeholderTotal}\n`);

	console.log('=== Open BackingLots → placeholders to KEEP (still physically in oven) ===');
	let keepTotal = 0;
	for (const bl of openLots as any[]) {
		const lotRec = await db.collection('lot_records').findOne({ bucketBarcode: bl._id });
		if (!lotRec) { console.log(`  BL=${bl._id}  no LotRecord found`); continue; }
		const stubCount = await db.collection('cartridge_records').countDocuments({
			'backing.lotId': lotRec._id,
			status: 'backing'
		});
		keepTotal += stubCount;
		console.log(`  BL=${bl._id}  LotRecord=${lotRec._id}  stubsStillBacking=${stubCount}`);
	}
	console.log(`  Placeholders to keep: ${keepTotal}\n`);

	const orphanBacking = await db.collection('cartridge_records').countDocuments({
		status: 'backing',
		'backing.lotId': { $exists: true, $ne: null }
	}) - placeholderTotal - keepTotal;
	console.log(`  Orphan (lotId has no BackingLot at all): ${orphanBacking}`);

	const nullLotBacking = await db.collection('cartridge_records').countDocuments({
		status: 'backing',
		$or: [{ 'backing.lotId': { $exists: false } }, { 'backing.lotId': null }]
	});
	console.log(`  status=backing with null lotId: ${nullLotBacking}`);

	await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
