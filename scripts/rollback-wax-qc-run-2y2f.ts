/**
 * One-shot rollback: undo an accidental "Complete QC" click on
 * wax-filling run 2y2fFrx6QdOaxhJMN78kt.
 *
 * Reverts:
 *   - 24 cartridges: status back to 'wax_filling', waxQc cleared,
 *     waxFilling.{waxTubeId,waxSourceLot,runStartTime,runEndTime,recordedAt} cleared
 *   - Run: status 'Storage' -> 'QC', runEndTime cleared
 *   - PT-CT-105 inventoryCount: restored by +N (where N = deleted tx count)
 *   - 24 PT-CT-105 'consumption' inventory_transactions: DELETED
 *   - Single AuditLog entry capturing the rollback
 *
 * Retains: backing.*, waxFilling.{runId,deckId,robotId,robotName,deckPosition,operator},
 *          ovenCure.*, photos, and everything else.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
const URI = process.env.MONGODB_URI!;

const RUN_ID = '2y2fFrx6QdOaxhJMN78kt';
const EXPECTED_CART_COUNT = 24;

function gen() {
	// nanoid not needed — audit uses a unique string; generate via mongo ObjectId-ish
	return new mongoose.Types.ObjectId().toString() + '-' + Math.random().toString(36).slice(2, 10);
}

async function main() {
	await mongoose.connect(URI);
	const db = mongoose.connection.db!;

	// === Pre-flight verification ===
	const run = await db.collection('wax_filling_runs').findOne({ _id: RUN_ID as any });
	if (!run) throw new Error(`Run ${RUN_ID} not found`);
	console.log(`Run status=${run.status}  cartridgeIds.length=${(run.cartridgeIds ?? []).length}  runEndTime=${run.runEndTime ?? '(none)'}`);
	if (run.status !== 'Storage') {
		throw new Error(`Run status is "${run.status}" — expected "Storage". Refusing to continue (state already changed?).`);
	}
	const cartIds: string[] = run.cartridgeIds ?? [];
	if (cartIds.length !== EXPECTED_CART_COUNT) {
		throw new Error(`Expected ${EXPECTED_CART_COUNT} cartridge IDs on run, found ${cartIds.length}. Refusing.`);
	}

	const cartsBefore = await db.collection('cartridge_records').find(
		{ _id: { $in: cartIds } },
		{ projection: { _id: 1, status: 1, 'waxQc.status': 1, 'waxFilling.recordedAt': 1 } }
	).toArray();
	if (cartsBefore.length !== EXPECTED_CART_COUNT) {
		throw new Error(`Expected ${EXPECTED_CART_COUNT} cartridge records, found ${cartsBefore.length}. Refusing.`);
	}
	const wrong = (cartsBefore as any[]).filter(c => c.status !== 'wax_filled' || c.waxQc?.status !== 'Accepted');
	if (wrong.length > 0) {
		console.error('Cartridges not in expected state (status=wax_filled, waxQc.status=Accepted):');
		for (const c of wrong) console.error(`  ${c._id}  status=${c.status}  qc=${c.waxQc?.status}`);
		throw new Error('Refusing to continue — cartridges already partially changed.');
	}
	console.log(`Pre-flight OK: 24 cartridges in status=wax_filled, waxQc.status=Accepted.\n`);

	// === Inventory transactions to delete ===
	// Note: PT-CT-105 is NOT a PartDefinition row, so resolvePartId returned null
	// during completeQC. The 24 tx rows were written with partDefinitionId=undefined
	// and no inventoryCount was decremented. So here we only delete the phantom
	// tx rows — nothing to restore on PartDefinition.
	const txFilter: any = {
		manufacturingRunId: RUN_ID,
		manufacturingStep: 'wax_filling',
		transactionType: 'consumption',
		cartridgeRecordId: { $in: cartIds }
	};
	const txs = await db.collection('inventory_transactions').find(txFilter).toArray();
	console.log(`Found ${txs.length} inventory_transactions matching run+wax_filling+consumption+in-cart-ids.`);
	const hasPartId = (txs as any[]).filter(t => t.partDefinitionId).length;
	if (hasPartId > 0) {
		throw new Error(`Expected all matching tx to have partDefinitionId=undefined (PT-CT-105 is not a PartDefinition). Found ${hasPartId} tx with partDefinitionId — different path than assumed. Refusing.`);
	}

	// === Apply changes ===
	console.log('\n--- Applying rollback ---\n');

	// 1) Cartridges: revert status + clear waxQc + clear completeQC-written waxFilling fields
	const cartOps = cartIds.map(cid => ({
		updateOne: {
			filter: { _id: cid },
			update: {
				$set: { status: 'wax_filling' },
				$unset: {
					waxQc: '',
					'waxFilling.waxTubeId': '',
					'waxFilling.waxSourceLot': '',
					'waxFilling.runStartTime': '',
					'waxFilling.runEndTime': '',
					'waxFilling.recordedAt': ''
				}
			}
		}
	}));
	const cartRes = await db.collection('cartridge_records').bulkWrite(cartOps);
	console.log(`Cartridges updated: matched=${cartRes.matchedCount} modified=${cartRes.modifiedCount}`);

	// 2) Run: status Storage -> QC, unset runEndTime
	const runRes = await db.collection('wax_filling_runs').updateOne(
		{ _id: RUN_ID as any },
		{ $set: { status: 'QC' }, $unset: { runEndTime: '' } }
	);
	console.log(`Run updated: matched=${runRes.matchedCount} modified=${runRes.modifiedCount}`);

	// 3) Delete inventory transactions (no inventoryCount change — PT-CT-105
	//    isn't a PartDefinition row so none was decremented to begin with).
	let delRes = { deletedCount: 0 };
	if (txs.length > 0) {
		delRes = await db.collection('inventory_transactions').deleteMany(txFilter) as any;
		console.log(`Inventory transactions deleted: ${delRes.deletedCount}`);
	}

	// 4) AuditLog entry
	await db.collection('audit_logs').insertOne({
		_id: gen(),
		tableName: 'wax_filling_runs',
		recordId: RUN_ID,
		action: 'ROLLBACK',
		changedBy: 'claude-code-admin-rollback',
		changedAt: new Date(),
		newData: {
			reason: 'Operator accidentally clicked Complete QC without inspecting cartridges. Reverted run from Storage to QC, cleared waxQc on 24 cartridges, deleted 24 phantom wax_filling consumption tx (PT-CT-105 has no PartDefinition row so no inventoryCount change needed).',
			runId: RUN_ID,
			cartridgeCount: EXPECTED_CART_COUNT,
			deletedTxCount: delRes.deletedCount
		}
	});
	console.log('AuditLog written.');

	// === Post-flight verification ===
	console.log('\n--- Verification ---\n');
	const runAfter = await db.collection('wax_filling_runs').findOne({ _id: RUN_ID as any });
	console.log(`Run status=${runAfter?.status}  runEndTime=${runAfter?.runEndTime ?? '(unset)'}`);

	const cartsAfter = await db.collection('cartridge_records').find(
		{ _id: { $in: cartIds } },
		{ projection: { _id: 1, status: 1, waxQc: 1, 'waxFilling.recordedAt': 1, 'waxFilling.runId': 1, 'waxFilling.deckPosition': 1, 'waxFilling.waxTubeId': 1, 'backing.lotId': 1, 'ovenCure.entryTime': 1 } }
	).toArray();
	const agg: Record<string, number> = {};
	let stillAccepted = 0;
	let stillHasRecordedAt = 0;
	let missingRunId = 0;
	let missingBacking = 0;
	for (const c of cartsAfter as any[]) {
		agg[c.status] = (agg[c.status] ?? 0) + 1;
		if (c.waxQc?.status) stillAccepted++;
		if (c.waxFilling?.recordedAt) stillHasRecordedAt++;
		if (!c.waxFilling?.runId) missingRunId++;
		if (!c.backing?.lotId) missingBacking++;
	}
	console.log(`Cartridge status counts: ${JSON.stringify(agg)}`);
	console.log(`Cartridges still with waxQc.status: ${stillAccepted} (should be 0)`);
	console.log(`Cartridges still with waxFilling.recordedAt: ${stillHasRecordedAt} (should be 0)`);
	console.log(`Cartridges missing waxFilling.runId: ${missingRunId} (should be 0)`);
	console.log(`Cartridges missing backing.lotId: ${missingBacking} (should be 0)`);

	const txAfter = await db.collection('inventory_transactions').countDocuments(txFilter);
	console.log(`Remaining matching inventory_transactions: ${txAfter} (should be 0)`);

	console.log('\nRollback complete.');
	await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
