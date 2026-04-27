/**
 * Reconcile physical truth: add 34 backed cartridges to BackingLot
 * 7a1cdd32-d86c-40f2-97f7-fc84e0298a04 to bring its cartridgeCount from 3 → 37.
 *
 * Per-cartridge material consumption mirrors WI-01:
 *   PT-CT-104 (Cartridge): 1 each
 *   PT-CT-112 (Thermoseal Laser Cut Sheet): 1 each
 *   PT-CT-106 (Barcode): 1 each
 *
 * Negative inventory is acceptable — the operator confirmed they will add a
 * fresh receiving lot afterward.
 *
 * Run with --apply to execute. Without that flag, dry-run only.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

const LOT_ID = '7a1cdd32-d86c-40f2-97f7-fc84e0298a04';
const ADD_COUNT = 34;
const PARTS = [
	{ partNumber: 'PT-CT-104', name: 'Cartridge' },
	{ partNumber: 'PT-CT-112', name: 'Thermoseal Laser Cut Sheet' },
	{ partNumber: 'PT-CT-106', name: 'Barcode' }
];
const OPERATOR = { _id: 'system-reconciliation', username: 'system-reconciliation' };
const REASON = 'Manual reconciliation 2026-04-27 — operator confirmed 37 physical cartridges in oven across all lots; system showed 3. Adding 34 to lot 7a1cdd32 to match physical truth. Operator will register a new receiving lot to cover any negative inventory this creates.';

async function main() {
	const apply = process.argv.includes('--apply');
	console.log(`MODE: ${apply ? 'APPLY' : 'DRY-RUN'}\n`);

	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;

	// 1. Inspect current lot state
	const lot = await db.collection('backing_lots').findOne({ _id: LOT_ID });
	if (!lot) {
		console.error(`Lot ${LOT_ID} not found.`);
		process.exit(1);
	}
	console.log(`Lot ${LOT_ID}:`);
	console.log(`  status=${lot.status}`);
	console.log(`  cartridgeCount BEFORE: ${lot.cartridgeCount}`);
	console.log(`  cartridgeCount AFTER:  ${(lot.cartridgeCount ?? 0) + ADD_COUNT}`);
	console.log(`  ovenLocationName=${lot.ovenLocationName}`);
	console.log('');

	// 2. Inspect part inventory (PartDefinition) for each consumed part
	console.log('Inventory impact (1 unit per cartridge × 34 cartridges):');
	const partImpacts: { partId: string | null; partNumber: string; name: string; before: number | null; after: number | null }[] = [];
	for (const p of PARTS) {
		const partDef = await db
			.collection('part_definitions')
			.findOne({ partNumber: p.partNumber });
		const before = partDef?.inventoryCount ?? null;
		const after = before === null ? null : before - ADD_COUNT;
		partImpacts.push({ partId: partDef?._id ?? null, partNumber: p.partNumber, name: p.name, before, after });
		console.log(
			`  ${p.partNumber} (${p.name}): ${before ?? '(no part_definition row)'} → ${after ?? '(unchanged — cannot deduct)'}${after !== null && after < 0 ? '  [negative — OK per operator]' : ''}`
		);
	}
	console.log('');

	if (!apply) {
		console.log('DRY-RUN complete. Re-run with --apply to execute.');
		await mongoose.disconnect();
		return;
	}

	const now = new Date();

	// 3. Increment BackingLot.cartridgeCount
	await db.collection('backing_lots').updateOne(
		{ _id: LOT_ID },
		{ $inc: { cartridgeCount: ADD_COUNT } }
	);
	console.log(`✓ BackingLot.cartridgeCount incremented by ${ADD_COUNT}`);

	// 4. Deduct PartDefinition.inventoryCount + write inventory_transactions
	for (const impact of partImpacts) {
		if (!impact.partId) {
			console.log(`  [skip] ${impact.partNumber}: no part_definitions row, only writing transaction (no inventoryCount to decrement)`);
		} else {
			await db
				.collection('part_definitions')
				.updateOne({ _id: impact.partId }, { $inc: { inventoryCount: -ADD_COUNT } });
			console.log(`✓ ${impact.partNumber}: inventoryCount -${ADD_COUNT}`);
		}

		// Insert inventory_transaction matching the WI-01 consumption shape.
		const txId = (await import('nanoid')).nanoid();
		await db.collection('inventory_transactions').insertOne({
			_id: txId,
			transactionType: 'consumption',
			partDefinitionId: impact.partId ?? undefined,
			partNumber: impact.partNumber,
			quantity: ADD_COUNT,
			manufacturingStep: 'backing',
			manufacturingRunId: LOT_ID,
			operatorId: OPERATOR._id,
			operatorUsername: OPERATOR.username,
			notes: `Reconciliation: ${ADD_COUNT}x ${impact.name} — ${REASON.slice(0, 200)}`,
			createdAt: now
		});
		console.log(`  → inventory_transactions row written (${impact.partNumber}, qty=${ADD_COUNT})`);
	}

	// 5. Audit log entry
	await db.collection('audit_logs').insertOne({
		_id: (await import('nanoid')).nanoid(),
		tableName: 'backing_lots',
		recordId: LOT_ID,
		action: 'RECONCILE',
		changedBy: OPERATOR.username,
		changedAt: now,
		reason: REASON,
		newData: {
			cartridgeCountAdded: ADD_COUNT,
			cartridgeCountBefore: lot.cartridgeCount,
			cartridgeCountAfter: (lot.cartridgeCount ?? 0) + ADD_COUNT,
			inventoryDeductedFor: PARTS.map((p) => `${p.partNumber} (${ADD_COUNT})`)
		}
	});
	console.log('✓ AuditLog entry written');

	console.log('\nDONE. Verify by re-running scripts/diag-backing-oven-detail.ts');

	await mongoose.disconnect();
}
main().catch((e) => {
	console.error(e);
	process.exit(1);
});
