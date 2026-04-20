import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
const URI = process.env.MONGODB_URI;
if (!URI) { console.error('MONGODB_URI missing'); process.exit(1); }

async function main() {
	await mongoose.connect(URI!);
	const db = mongoose.connection.db!;

	// Remove from the wrong collection
	await db.collection('receivinglots').deleteOne({ lotId: 'TEST-WAX-15ML-001' });

	// Find PT-CT-114 part
	const part = await db.collection('part_definitions').findOne({ partNumber: 'PT-CT-114' }) as any;
	if (!part) { console.error('PT-CT-114 not found'); process.exit(1); }

	const now = new Date();
	const res = await db.collection('receiving_lots').updateOne(
		{ lotId: 'TEST-WAX-15ML-001' },
		{
			$setOnInsert: {
				_id: 'TEST-WAX-15ML-001',
				lotId: 'TEST-WAX-15ML-001',
				lotNumber: 'LOT-WAX-TEST-001',
				bagBarcode: 'TEST-WAX-15ML-001',
				part: { _id: String(part._id), partNumber: 'PT-CT-114', name: part.name ?? '15ml Filled Wax Tube' },
				quantity: 10,
				status: 'accepted',
				receivedAt: now,
				createdAt: now,
				updatedAt: now
			}
		},
		{ upsert: true }
	);

	const lot = await db.collection('receiving_lots').findOne({ lotId: 'TEST-WAX-15ML-001' }) as any;
	console.log('Fixed. Lot now in receiving_lots:');
	console.log('  lotId:', lot?.lotId);
	console.log('  part:', lot?.part?.partNumber, '—', lot?.part?.name);
	console.log('  quantity:', lot?.quantity);
	console.log('  status:', lot?.status);
	console.log('\nScan: TEST-WAX-15ML-001');

	await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
