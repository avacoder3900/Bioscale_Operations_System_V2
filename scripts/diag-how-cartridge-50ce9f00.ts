/**
 * Trace how cartridge 50ce9f00-bff6-42d3-ad14-b8540f4e5d9a ended up in a
 * reagent run while its parent wax run was still open.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
const CART_ID = '50ce9f00-bff6-42d3-ad14-b8540f4e5d9a';
(async () => {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const c = await db.collection('cartridge_records').findOne({ _id: CART_ID } as any) as any;
	if (!c) { console.log('not found'); process.exit(1); }
	console.log('=== Cartridge', CART_ID, '===');
	console.log('  status            :', c.status);
	console.log('  waxFilling.runId  :', c.waxFilling?.runId);
	console.log('  waxFilling.recordedAt :', c.waxFilling?.recordedAt?.toISOString?.());
	console.log('  waxQc.status      :', c.waxQc?.status);
	console.log('  waxQc.recordedAt  :', c.waxQc?.recordedAt?.toISOString?.());
	console.log('  waxStorage.location :', c.waxStorage?.location);
	console.log('  waxStorage.recordedAt :', c.waxStorage?.recordedAt?.toISOString?.());
	console.log('  reagentFilling.runId :', c.reagentFilling?.runId);
	console.log('  reagentFilling.recordedAt :', c.reagentFilling?.recordedAt?.toISOString?.());

	if (c.reagentFilling?.runId) {
		const rr = await db.collection('reagent_batch_records').findOne({ _id: c.reagentFilling.runId } as any) as any;
		console.log('\n=== Reagent run', c.reagentFilling.runId, '===');
		console.log('  status            :', rr?.status);
		console.log('  createdAt         :', rr?.createdAt?.toISOString?.());
		console.log('  robot             :', rr?.robot?.name);
		console.log('  assayType         :', rr?.assayType?.name);
	}

	if (c.waxFilling?.runId) {
		const wr = await db.collection('wax_filling_runs').findOne({ _id: c.waxFilling.runId } as any) as any;
		console.log('\n=== Parent wax run', c.waxFilling.runId, '===');
		console.log('  status            :', wr?.status);
		console.log('  createdAt         :', wr?.createdAt?.toISOString?.());
		console.log('  runEndTime        :', wr?.runEndTime?.toISOString?.());
	}

	console.log('\n=== Timeline ===');
	const events: { when: Date; what: string }[] = [];
	if (c.waxFilling?.recordedAt) events.push({ when: new Date(c.waxFilling.recordedAt), what: 'wax completeQC → status=wax_filled' });
	if (c.waxQc?.recordedAt) events.push({ when: new Date(c.waxQc.recordedAt), what: 'waxQc recorded → ' + c.waxQc.status });
	if (c.waxStorage?.recordedAt) events.push({ when: new Date(c.waxStorage.recordedAt), what: 'waxStorage recordBatchStorage → status=wax_stored, fridge=' + c.waxStorage.location });
	if (c.reagentFilling?.recordedAt) events.push({ when: new Date(c.reagentFilling.recordedAt), what: 'reagent loadDeck → status=reagent_filling (runId=' + c.reagentFilling.runId + ')' });
	events.sort((a, b) => a.when.getTime() - b.when.getTime());
	for (const e of events) console.log(`  ${e.when.toISOString()}  ${e.what}`);

	if (c.waxFilling?.runId) {
		const wr = await db.collection('wax_filling_runs').findOne({ _id: c.waxFilling.runId } as any) as any;
		console.log(`\n  Wax run status at time of reagent load: ${wr?.status === 'completed' ? 'completed' : 'still open (' + wr?.status + ')'}`);
	}
	await mongoose.disconnect();
})();
