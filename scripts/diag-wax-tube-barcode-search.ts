import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
const URI = process.env.MONGODB_URI;
if (!URI) { console.error('MONGODB_URI missing'); process.exit(1); }

const BARCODE = process.argv[2] || '74b942a2-16a5-4ae4-aa91-917d3ecc146a';

async function main() {
	await mongoose.connect(URI!);
	const db = mongoose.connection.db!;

	console.log(`\n=== Searching all collections for barcode: ${BARCODE} ===\n`);

	const collections = await db.listCollections().toArray();
	for (const c of collections) {
		const name = c.name;
		// Search any string field for an exact match of the barcode
		try {
			const docs = await db.collection(name).find({
				$or: [
					{ _id: BARCODE },
					{ lotId: BARCODE },
					{ lotNumber: BARCODE },
					{ bagBarcode: BARCODE },
					{ barcode: BARCODE },
					{ tubeId: BARCODE },
					{ id: BARCODE }
				]
			}).limit(5).toArray();
			if (docs.length > 0) {
				console.log(`-- HIT in collection: ${name} (${docs.length}) --`);
				console.log(JSON.stringify(docs, null, 2));
				console.log();
			}
		} catch (e) {
			// some collections may not match types; ignore
		}
	}

	console.log('\n=== ReceivingLots: ALL distinct part numbers ===');
	const partNumbers = await db.collection('receivinglots').distinct('part.partNumber');
	console.log(partNumbers);

	console.log('\n=== ReceivingLots: any part name containing "wax" ===');
	const waxByName = await db.collection('receivinglots').find({
		'part.name': { $regex: /wax/i }
	}).project({ _id: 1, lotId: 1, lotNumber: 1, status: 1, 'part.partNumber': 1, 'part.name': 1, quantity: 1, waxMelt: 1 }).toArray();
	console.log(`Found ${waxByName.length}:`);
	console.log(JSON.stringify(waxByName, null, 2));

	console.log('\n=== Consumables with type containing "wax" or part PT-CT-114 ===');
	const consumables = await db.collection('consumables').find({
		$or: [
			{ type: { $regex: /wax/i } },
			{ 'part.partNumber': 'PT-CT-114' },
			{ partNumber: 'PT-CT-114' }
		]
	}).limit(20).toArray();
	console.log(`Found ${consumables.length}:`);
	console.log(JSON.stringify(consumables, null, 2));

	await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
