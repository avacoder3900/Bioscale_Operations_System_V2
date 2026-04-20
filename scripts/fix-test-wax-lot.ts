import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
const URI = process.env.MONGODB_URI;
if (!URI) { console.error('MONGODB_URI missing'); process.exit(1); }

async function main() {
	await mongoose.connect(URI!);
	const db = mongoose.connection.db!;

	// Ensure PT-CT-114 part definition exists
	let part = await db.collection('part_definitions').findOne({ partNumber: 'PT-CT-114' }) as any;
	if (!part) {
		const { nanoid } = await import('nanoid');
		const id = nanoid();
		await db.collection('part_definitions').insertOne({
			_id: id, partNumber: 'PT-CT-114', name: '15ml Filled Wax Tube',
			bomType: 'cartridge', isActive: true, inventoryCount: 10,
			minimumOrderQty: 5, unitOfMeasure: 'pcs',
			createdAt: new Date(), updatedAt: new Date()
		});
		part = { _id: id, partNumber: 'PT-CT-114', name: '15ml Filled Wax Tube' };
		console.log('Created PT-CT-114 part definition');
	} else {
		console.log('PT-CT-114 exists: _id=' + String(part._id));
	}

	// Update the test lot to reference PT-CT-114
	const res = await db.collection('receivinglots').updateOne(
		{ lotId: 'TEST-WAX-15ML-001' },
		{ $set: {
			'part._id': String(part._id),
			'part.partNumber': 'PT-CT-114',
			'part.name': part.name ?? '15ml Filled Wax Tube'
		} }
	);
	console.log('Updated lot: modified=' + res.modifiedCount);

	// Verify
	const lot = await db.collection('receivinglots').findOne({ lotId: 'TEST-WAX-15ML-001' }) as any;
	console.log('\nVerification:');
	console.log('  lotId:', lot?.lotId);
	console.log('  part:', lot?.part?.partNumber, '—', lot?.part?.name);
	console.log('  quantity:', lot?.quantity);
	console.log('  status:', lot?.status);
	console.log('\nScan this: TEST-WAX-15ML-001');

	await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
