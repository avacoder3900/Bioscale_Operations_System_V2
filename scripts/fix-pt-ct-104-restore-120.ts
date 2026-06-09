/**
 * One-shot inventory correction: bring PT-CT-104 (Cartridge) back to 120
 * with an additive `adjustment` transaction. No data is deleted; the
 * existing consumption history stays intact.
 *
 * Cascade matches the ROG path used by parts/accession + the placeholder
 * loader at scripts/add-placeholder-inventory.ts:
 *   1. PartDefinition.inventoryCount → $inc by delta
 *   2. InventoryTransaction (type='adjustment') for the audit trail
 *   3. ManufacturingMaterial.currentQuantity sync + recentTransactions
 *      push (only if a linked ManufacturingMaterial exists)
 *   4. AuditLog row tying the change back to the operator + reason
 *
 * Idempotent: re-running while already at 120 is a no-op.
 */
import mongoose from 'mongoose';
import { nanoid } from 'nanoid';
import * as dotenv from 'dotenv';
dotenv.config();

const URI = process.env.MONGODB_URI!;
if (!URI) throw new Error('MONGODB_URI not set');

const TARGET_PART_NUMBER = 'PT-CT-104';
const TARGET_QUANTITY = 120;
const REASON = 'Restore PT-CT-104 to 120 (manual one-time correction)';
const OPERATOR = { _id: '3CKmpYNUsQQv2rFVT0-ej', username: 'jacob' };

function newId(size = 21) {
	return nanoid(size);
}

async function main() {
	await mongoose.connect(URI);
	const db = mongoose.connection.db!;
	const parts = db.collection('part_definitions');
	const txns = db.collection('inventory_transactions');
	const mfgMat = db.collection('manufacturing_materials');
	const mfgTxn = db.collection('manufacturing_material_transactions');
	const audit = db.collection('audit_log');

	const part = await parts.findOne({ partNumber: TARGET_PART_NUMBER }) as any;
	if (!part) throw new Error(`PartDefinition ${TARGET_PART_NUMBER} not found`);

	const previous = part.inventoryCount ?? 0;
	const delta = TARGET_QUANTITY - previous;
	console.log(
		`PT-CT-104 inventory before: ${previous}; target: ${TARGET_QUANTITY}; delta: ${delta > 0 ? '+' : ''}${delta}`
	);

	if (delta === 0) {
		console.log('Already at target — nothing to do.');
		await mongoose.disconnect();
		return;
	}

	const now = new Date();

	await parts.updateOne({ _id: part._id }, { $inc: { inventoryCount: delta } });

	const txId = newId();
	await txns.insertOne({
		_id: txId,
		partDefinitionId: part._id,
		transactionType: 'adjustment',
		quantity: delta,
		previousQuantity: previous,
		newQuantity: TARGET_QUANTITY,
		reason: REASON,
		notes: REASON,
		performedBy: OPERATOR.username,
		performedAt: now,
		operatorId: OPERATOR._id,
		operatorUsername: OPERATOR.username
	} as any);
	console.log(`InventoryTransaction created: ${txId}`);

	const mm = await mfgMat.findOne({ partDefinitionId: part._id });
	if (mm) {
		const mfgBefore = (mm as any).currentQuantity ?? 0;
		const mfgAfter = mfgBefore + delta;
		const mfgTxId = newId();
		await mfgTxn.insertOne({
			_id: mfgTxId,
			materialId: mm._id,
			transactionType: 'adjustment',
			quantityChanged: delta,
			quantityBefore: mfgBefore,
			quantityAfter: mfgAfter,
			operatorId: OPERATOR._id,
			notes: REASON,
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
								transactionType: 'adjustment',
								quantityChanged: delta,
								quantityBefore: mfgBefore,
								quantityAfter: mfgAfter,
								operatorId: OPERATOR._id,
								notes: REASON,
								createdAt: now
							}
						],
						$slice: -100
					}
				}
			} as any
		);
		console.log(
			`ManufacturingMaterial synced: ${mm._id} (${mfgBefore} → ${mfgAfter}); txn ${mfgTxId}`
		);
	} else {
		console.log('No ManufacturingMaterial linked to PT-CT-104 — skipping sync.');
	}

	const auditId = newId();
	await audit.insertOne({
		_id: auditId,
		tableName: 'part_definitions',
		recordId: part._id,
		action: 'UPDATE',
		oldData: { inventoryCount: previous },
		newData: { inventoryCount: TARGET_QUANTITY },
		changedAt: now,
		changedBy: OPERATOR.username,
		reason: REASON
	} as any);
	console.log(`AuditLog created: ${auditId}`);

	await mongoose.disconnect();
	console.log(`✔ PT-CT-104 inventory now ${TARGET_QUANTITY}`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
