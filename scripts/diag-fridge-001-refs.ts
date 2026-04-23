import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
const URI = process.env.MONGODB_URI!;

const IDS = [
	'4eeaa1c2-51e1-4bb9-a365-ec3bc1792861',
	'f81483a1-9250-4c79-bb13-4f8b662bd683',
	'7d62356c-7dae-43f6-8167-4c3c4ad908ed',
	'9b4d325f-4599-44ba-9bc5-31135c804f7b',
	'2752e88e-23cf-4596-a295-aba31b0824f5',
	'983be2c8-6c72-494a-97b2-e5bb8a0f9ee1',
	'fd6140ca-57b0-4a58-93f4-814b167533d9',
	'79ab3eee-67df-4179-b493-0e0b234c1120',
	'ba31cef3-b5de-4657-80fc-75280a400f73',
	'1bbc8933-edb5-4976-a127-5844cb915e6b',
	'6271346a-c16e-40c9-8262-7d252d6676bf'
];

async function main() {
	await mongoose.connect(URI);
	const db = mongoose.connection.db!;

	// Pull full docs to examine cross-references
	const docs = await db.collection('cartridge_records').find({ _id: { $in: IDS } }).toArray();
	console.log(`Full cartridge_records: ${docs.length}`);
	const waxRunIds = new Set<string>();
	const backingLotIds = new Set<string>();
	const reagentRunIds = new Set<string>();
	const shippingPkgIds = new Set<string>();
	const shippingLotIds = new Set<string>();
	for (const d of docs as any[]) {
		if (d.waxFilling?.runId) waxRunIds.add(d.waxFilling.runId);
		if (d.backing?.lotId) backingLotIds.add(d.backing.lotId);
		if (d.reagentFilling?.runId) reagentRunIds.add(d.reagentFilling.runId);
		if (d.shipping?.packageId) shippingPkgIds.add(d.shipping.packageId);
		if (d.qaqcRelease?.shippingLotId) shippingLotIds.add(d.qaqcRelease.shippingLotId);
	}
	console.log(`\n  Referenced waxFilling.runIds     : ${[...waxRunIds].join(', ') || '(none)'}`);
	console.log(`  Referenced backing.lotIds        : ${[...backingLotIds].join(', ') || '(none)'}`);
	console.log(`  Referenced reagentFilling.runIds : ${[...reagentRunIds].join(', ') || '(none)'}`);
	console.log(`  Referenced shipping.packageIds   : ${[...shippingPkgIds].join(', ') || '(none)'}`);
	console.log(`  Referenced qaqcRelease.shippingLotIds: ${[...shippingLotIds].join(', ') || '(none)'}`);

	console.log('\n=== Print sample fields from one record ===');
	if (docs[0]) {
		const d = docs[0] as any;
		console.log(`  status=${d.status}  finalizedAt=${d.finalizedAt}  voidedAt=${d.voidedAt}`);
		console.log(`  backing=${JSON.stringify(d.backing)}`);
		console.log(`  waxFilling=${JSON.stringify(d.waxFilling)}`);
		console.log(`  waxQc=${JSON.stringify(d.waxQc)}`);
		console.log(`  waxStorage=${JSON.stringify(d.waxStorage)}`);
		console.log(`  reagentFilling=${JSON.stringify(d.reagentFilling)}`);
		console.log(`  shipping=${JSON.stringify(d.shipping)}`);
		console.log(`  createdAt=${d.createdAt?.toISOString?.()}`);
	}

	// Check collections that may reference these cartridgeRecord _ids
	console.log('\n=== Cross-references in other collections ===');
	const invTx = await db.collection('inventory_transactions').countDocuments({ cartridgeRecordId: { $in: IDS } });
	console.log(`  inventory_transactions by cartridgeRecordId: ${invTx}`);

	const auditByRecord = await db.collection('audit_logs').countDocuments({
		$or: [
			{ recordId: { $in: IDS } },
			{ 'newData.cartridgeId': { $in: IDS } }
		]
	});
	console.log(`  audit_logs referencing these ids: ${auditByRecord}`);

	// Are their backing lots also a concern?
	if (backingLotIds.size > 0) {
		const bl = await db.collection('backing_lots').find({ _id: { $in: [...backingLotIds] } }).toArray();
		console.log(`  backing_lots matched: ${bl.length}`);
		for (const b of bl as any[]) {
			console.log(`    ${b._id} status=${b.status} cartridgeCount=${b.cartridgeCount}`);
		}
	}

	// Wax filling runs affected?
	if (waxRunIds.size > 0) {
		const wr = await db.collection('wax_filling_runs').find({ _id: { $in: [...waxRunIds] } }).toArray();
		console.log(`  wax_filling_runs matched: ${wr.length}`);
		for (const r of wr as any[]) {
			console.log(`    ${r._id} status=${r.status} cartridgeCount=${r.cartridgeIds?.length ?? 'n/a'}`);
		}
	}

	await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
