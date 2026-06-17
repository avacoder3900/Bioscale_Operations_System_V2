/**
 * Seeds a 15ml wax source lot (PT-CT-110) into receivinglots so the
 * wax-filling scan step has something to match. Read-safe: uses upsert
 * so re-running won't duplicate.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

const URI = process.env.MONGODB_URI;
if (!URI) { console.error('MONGODB_URI missing'); process.exit(1); }

async function main() {
	await mongoose.connect(URI!);
	const db = mongoose.connection.db!;

	const now = new Date();

	// Find the PT-CT-110 part definition (15ml wax tube)
	let part110 = await db.collection('part_definitions').findOne({ partNumber: 'PT-CT-110' }) as any;
	// Fallback: try PT-CT-114 (filled wax tube — recent rename)
	if (!part110) part110 = await db.collection('part_definitions').findOne({ partNumber: 'PT-CT-114' }) as any;

	if (!part110) {
		console.log('Neither PT-CT-110 nor PT-CT-114 exists in part_definitions.');
		console.log('Creating a minimal PT-CT-114 part definition...');
		const { nanoid } = await import('nanoid');
		const partId = nanoid();
		await db.collection('part_definitions').insertOne({
			_id: partId,
			partNumber: 'PT-CT-114',
			name: '15ml Filled Wax Tube',
			bomType: 'cartridge',
			isActive: true,
			inventoryCount: 10,
			minimumOrderQty: 5,
			unitOfMeasure: 'pcs',
			createdAt: now,
			updatedAt: now
		});
		part110 = { _id: partId, partNumber: 'PT-CT-114', name: '15ml Filled Wax Tube' };
		console.log(`Created PT-CT-114 with _id=${partId}`);
	}

	const lotId = 'TEST-WAX-15ML-001';
	const lotNumber = 'LOT-WAX-TEST-001';

	const result = await db.collection('receivinglots').updateOne(
		{ lotId },
		{
			$setOnInsert: {
				_id: lotId,
				lotId,
				lotNumber,
				bagBarcode: lotId,
				part: { _id: String(part110._id), partNumber: part110.partNumber, name: part110.name },
				quantity: 10,
				status: 'accepted',
				receivedAt: now,
				createdAt: now,
				updatedAt: now
			}
		},
		{ upsert: true }
	);

	if (result.upsertedCount) {
		console.log(`\nCreated 15ml wax source lot:`);
	} else {
		console.log(`\n15ml wax source lot already exists:`);
	}
	console.log(`  lotId:    ${lotId}`);
	console.log(`  barcode:  ${lotId}  (scan this)`);
	console.log(`  part:     ${part110.partNumber} — ${part110.name}`);
	console.log(`  quantity: 10`);

	console.log(`\n=== Use these for testing ===`);
	console.log(`  15ml wax source (scan in Wax Preparation): TEST-WAX-15ML-001`);
	console.log(`  2ml incubator tube (scan in Wax Preparation): ITUB-U3TM`);

	await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
