/**
 * One-shot: create two placeholder ReceivingLots
 *   - PT-CT-104 (Cartridge) quantity 500
 *   - PT-CT-106 (Barcode)   quantity 400
 *
 * Mirrors the Quick Scan accession path at
 * src/routes/parts/accession/+page.server.ts:346-431 — ReceivingLot,
 * PartDefinition.inventoryCount bump, InventoryTransaction (receipt),
 * AuditLog, and ManufacturingMaterial sync if linked.
 *
 * The real supplier lot barcodes will be swapped in later — until then
 * the `lotId` contains the string "PLACEHOLDER" so they cannot be
 * mistaken for a scanned supplier lot.
 */
import mongoose from 'mongoose';
import { nanoid } from 'nanoid';
import * as dotenv from 'dotenv';
dotenv.config();

const URI = process.env.MONGODB_URI!;

function generateId(size = 21) {
	return nanoid(size);
}

async function generateLotNumber(col: any): Promise<string> {
	const now = new Date();
	const dateStr =
		`${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
	const prefix = `LOT-${dateStr}-`;
	const latest = await col.findOne(
		{ lotNumber: { $regex: `^${prefix}` } },
		{ sort: { lotNumber: -1 }, projection: { lotNumber: 1 } }
	);
	let seq = 1;
	if (latest?.lotNumber) {
		const n = parseInt(latest.lotNumber.slice(-4), 10);
		if (!isNaN(n)) seq = n + 1;
	}
	return `${prefix}${String(seq).padStart(4, '0')}`;
}

async function addPlaceholderLot(opts: {
	partNumber: string;
	quantity: number;
	lotId: string;
	operator: { _id: string; username: string };
}) {
	const db = mongoose.connection.db!;
	const parts = db.collection('part_definitions');
	const receiving = db.collection('receiving_lots');
	const txns = db.collection('inventory_transactions');
	const mfgMat = db.collection('manufacturing_materials');
	const mfgTxn = db.collection('manufacturing_material_transactions');
	const audit = db.collection('audit_logs');

	const part = await parts.findOne({ partNumber: opts.partNumber });
	if (!part) throw new Error(`PartDefinition ${opts.partNumber} not found`);

	const dup = await receiving.findOne({ lotId: opts.lotId });
	if (dup) throw new Error(`lotId ${opts.lotId} already exists — _id=${dup._id}`);

	const lotNumber = await generateLotNumber(receiving);
	const now = new Date();

	const lotDocId = generateId();
	await receiving.insertOne({
		_id: lotDocId,
		lotId: opts.lotId,
		lotNumber,
		part: { _id: part._id, partNumber: (part as any).partNumber, name: (part as any).name },
		quantity: opts.quantity,
		consumedUl: 0,
		operator: opts.operator,
		inspectionPathway: 'coc',
		cocMeetsStandards: true,
		firstArticleInspection: false,
		storageConditionsRequired: false,
		esdHandlingRequired: false,
		status: 'accepted',
		notes: 'PLACEHOLDER lot — real supplier lot barcode will be swapped in later.',
		bagBarcode: opts.lotId,
		createdAt: now,
		updatedAt: now
	} as any);

	const prev = (part as any).inventoryCount ?? 0;
	const next = prev + opts.quantity;
	await parts.updateOne({ _id: part._id }, { $inc: { inventoryCount: opts.quantity } });

	await txns.insertOne({
		_id: generateId(),
		partDefinitionId: part._id,
		transactionType: 'receipt',
		quantity: opts.quantity,
		previousQuantity: prev,
		newQuantity: next,
		reason: `Placeholder inventory load — lot ${lotNumber}`,
		performedBy: opts.operator.username,
		performedAt: now
	} as any);

	const mm = await mfgMat.findOne({ partDefinitionId: part._id });
	if (mm) {
		const mfgBefore = (mm as any).currentQuantity ?? 0;
		const mfgAfter = mfgBefore + opts.quantity;
		await mfgTxn.insertOne({
			_id: generateId(),
			materialId: mm._id,
			transactionType: 'receive',
			quantityChanged: opts.quantity,
			quantityBefore: mfgBefore,
			quantityAfter: mfgAfter,
			operatorId: opts.operator._id,
			notes: `Placeholder load via script, lot ${lotNumber}`,
			createdAt: now
		} as any);
		await mfgMat.updateOne(
			{ _id: mm._id },
			{
				$set: { currentQuantity: mfgAfter, updatedAt: now },
				$push: {
					recentTransactions: {
						$each: [
							{
								transactionType: 'receive',
								quantityChanged: opts.quantity,
								quantityBefore: mfgBefore,
								quantityAfter: mfgAfter,
								operatorId: opts.operator._id,
								notes: `Placeholder load via script, lot ${lotNumber}`,
								createdAt: now
							}
						],
						$slice: -100
					}
				}
			} as any
		);
	}

	await audit.insertOne({
		_id: generateId(),
		tableName: 'receiving_lot',
		recordId: lotDocId,
		action: 'CREATE',
		oldData: null,
		newData: {
			lotId: opts.lotId,
			lotNumber,
			partNumber: opts.partNumber,
			quantity: opts.quantity,
			status: 'accepted',
			placeholder: true
		},
		changedAt: now,
		changedBy: opts.operator.username,
		reason: 'Placeholder inventory load — real barcode to be scanned in later'
	} as any);

	return {
		lotDocId,
		lotId: opts.lotId,
		lotNumber,
		partNumber: opts.partNumber,
		quantity: opts.quantity,
		previousCount: prev,
		newCount: next
	};
}

async function main() {
	await mongoose.connect(URI);
	const operator = { _id: '3CKmpYNUsQQv2rFVT0-ej', username: 'jacob' };

	const a = await addPlaceholderLot({
		partNumber: 'PT-CT-104',
		quantity: 500,
		lotId: 'PLACEHOLDER-CT-104-20260422',
		operator
	});
	console.log('PT-CT-104 ✔', a);

	const b = await addPlaceholderLot({
		partNumber: 'PT-CT-106',
		quantity: 400,
		lotId: 'PLACEHOLDER-CT-106-20260422',
		operator
	});
	console.log('PT-CT-106 ✔', b);

	await mongoose.disconnect();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
