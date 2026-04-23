import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
const URI = process.env.MONGODB_URI!;

async function main() {
	await mongoose.connect(URI);
	const db = mongoose.connection.db!;

	for (const pn of ['PT-CT-104', 'PT-CT-106']) {
		console.log(`\n=== PartDefinition ${pn} ===`);
		const part = await db.collection('part_definitions').findOne({ partNumber: pn });
		if (part) {
			console.log(JSON.stringify({
				_id: part._id,
				partNumber: (part as any).partNumber,
				name: (part as any).name,
				inventoryCount: (part as any).inventoryCount,
				minimumOrderQty: (part as any).minimumOrderQty,
				unitOfMeasure: (part as any).unitOfMeasure,
				supplier: (part as any).supplier,
				vendorPartNumber: (part as any).vendorPartNumber,
				inspectionPathway: (part as any).inspectionPathway
			}, null, 2));
		} else {
			console.log('NOT FOUND');
		}

		console.log(`\n=== Last 3 ReceivingLots for ${pn} (sorted by createdAt desc) ===`);
		const lots = await db.collection('receiving_lots')
			.find({ 'part.partNumber': pn })
			.sort({ createdAt: -1 })
			.limit(3)
			.toArray();
		console.log(`Found ${lots.length}`);
		for (const l of lots as any[]) {
			console.log(JSON.stringify({
				_id: l._id,
				lotId: l.lotId,
				lotNumber: l.lotNumber,
				part: l.part,
				quantity: l.quantity,
				consumedUl: l.consumedUl,
				serialNumber: l.serialNumber,
				operator: l.operator,
				inspectionPathway: l.inspectionPathway,
				poReference: l.poReference,
				supplier: l.supplier,
				vendorLotNumber: l.vendorLotNumber,
				expirationDate: l.expirationDate,
				firstArticleInspection: l.firstArticleInspection,
				storageConditionsRequired: l.storageConditionsRequired,
				esdHandlingRequired: l.esdHandlingRequired,
				dispositionType: l.dispositionType,
				status: l.status,
				createdAt: l.createdAt,
				checklist: l.checklist,
				formFitFunctionCheck: l.formFitFunctionCheck
			}, null, 2));
		}
	}

	await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
