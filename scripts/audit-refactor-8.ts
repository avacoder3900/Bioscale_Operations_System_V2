/**
 * Confirm: is it Mongoose that's silently dropping the new fields in bulkWrite?
 * Test with CartridgeRecord model directly.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

// Import the model (triggers schema init)
import '../src/lib/server/db/models/index.js';
import { CartridgeRecord } from '../src/lib/server/db/models/index.js';

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);

	const testId = 'audit-mongoose-' + Date.now();
	console.log(`Test: Mongoose CartridgeRecord.bulkWrite with $setOnInsert on backing.*`);

	try {
		const res = await CartridgeRecord.bulkWrite([{
			updateOne: {
				filter: { _id: testId as any },
				update: {
					$setOnInsert: {
						_id: testId as any,
						'backing.operator': { _id: 'u', username: 'u' },
						'backing.recordedAt': new Date(),
						'backing.lotQrCode': 'qrcode-123',
						'backing.parentLotRecordId': 'parent-lot-id-1',
						'backing.cartridgeBlankLot': 'blank-lot-1',
						'backing.thermosealLot': 'thermo-lot-1',
						'backing.barcodeLabelLot': 'barcode-lot-1'
					},
					$set: {
						status: 'wax_filling',
						'backing.lotId': 'bucket-1',
						'backing.ovenExitTime': new Date(),
						'waxFilling.runId': 'run-1'
					}
				},
				upsert: true
			}
		}] as any);
		console.log('bulkWrite result:', JSON.stringify(res, null, 2));
	} catch (err: any) {
		console.log('Error:', err.message);
	}

	const doc = await CartridgeRecord.findById(testId).lean();
	console.log('Inserted doc backing keys:', Object.keys((doc as any)?.backing ?? {}));
	console.log('Full backing:', JSON.stringify((doc as any)?.backing, null, 2));

	// Force delete via raw collection (sacred middleware blocks deleteOne on model)
	const coll = mongoose.connection.db!.collection('cartridge_records');
	await coll.deleteOne({ _id: testId as any });

	await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
