/**
 * Directly test whether an upsert with both $setOnInsert on 'backing.x'
 * and $set on 'backing.y' conflict in this Mongo instance / Mongoose version.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;

	const testColl = db.collection('_audit_test_setoninsert');
	try { await testColl.drop(); } catch {}

	// Test 1: dotted paths in $setOnInsert and $set — both overlap on top-level 'backing'
	const testId = 'audit-test-' + Date.now();
	console.log(`Test 1: upsert with $setOnInsert dotted + $set dotted on same top-level object`);
	try {
		const res = await testColl.bulkWrite([{
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
		}]);
		console.log('bulkWrite result:', JSON.stringify(res, null, 2));
		const doc = await testColl.findOne({ _id: testId as any });
		console.log('Inserted doc backing subdoc:', JSON.stringify((doc as any)?.backing, null, 2));
		console.log('Has parentLotRecordId?', !!(doc as any)?.backing?.parentLotRecordId);
	} catch (err: any) {
		console.log('Error during upsert:', err.message);
	}

	// Test 2: $setOnInsert with full backing object and $set with dotted field
	try { await testColl.drop(); } catch {}
	const testId2 = 'audit-test2-' + Date.now();
	console.log(`\nTest 2: $setOnInsert with 'backing' as full object vs $set with 'backing.lotId'`);
	try {
		const res2 = await testColl.bulkWrite([{
			updateOne: {
				filter: { _id: testId2 as any },
				update: {
					$setOnInsert: {
						_id: testId2 as any,
						backing: { operator: { _id: 'u' }, parentLotRecordId: 'parent-2' }
					},
					$set: {
						'backing.lotId': 'bucket-2'
					}
				},
				upsert: true
			}
		}]);
		console.log('bulkWrite result:', JSON.stringify(res2, null, 2));
		const doc2 = await testColl.findOne({ _id: testId2 as any });
		console.log('Doc:', JSON.stringify(doc2, null, 2));
	} catch (err: any) {
		console.log('Error:', err.message);
	}

	// Cleanup
	try { await testColl.drop(); } catch {}

	// Now, let's check the latest run's cartridge with a fresh query:
	console.log('\n== Latest cart - raw doc ==');
	const cartridges = db.collection('cartridge_records');
	const c = await cartridges.findOne({ _id: '47512ea2-4fbe-450a-8881-37b16038c49a' });
	console.log(JSON.stringify((c as any)?.backing, null, 2));
	console.log('backing keys:', Object.keys((c as any)?.backing ?? {}));

	await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
