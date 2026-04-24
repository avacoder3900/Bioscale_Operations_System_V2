/**
 * Admin-override completion of the stuck wax run 2y2fFrx6QdOaxhJMN78kt.
 *
 * All 24 cartridges have already been past wax storage (23 at status=wax_stored,
 * 1 at status=reagent_filled — the one stuck in the UI). The recordBatchStorage
 * write-once filter was silently no-op-ing clicks because its waxStorage was
 * already set.
 *
 * This script applies the same mutations the normal `completeRun` action
 * would: mark run completed + runEndTime, log deck usage, decrement wax tube
 * and wax source lot, write AuditLog rows. No new CartridgeRecord mutations —
 * they're all already correct.
 *
 * Idempotent guard: aborts if run.status is already 'completed'.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
import { nanoid } from 'nanoid';

const RUN_ID = '2y2fFrx6QdOaxhJMN78kt';
const WAX_FILL_VOLUME_UL = 800;
const FULL_TUBE_VOLUME_UL = 12000;

(async () => {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const now = new Date();
	const operator = { _id: 'system-admin-override', username: 'system-admin-override' };

	// --- 1. Read the run ---
	const run = await db.collection('wax_filling_runs').findOne({ _id: RUN_ID } as any) as any;
	if (!run) { console.error(`Run ${RUN_ID} not found`); process.exit(1); }
	if (run.status === 'completed') { console.log('Run is already completed — nothing to do.'); process.exit(0); }
	console.log(`Run state: status=${run.status}  cartridgeIds.length=${(run.cartridgeIds ?? []).length}`);
	console.log(`  deckId=${run.deckId}  waxTubeId=${run.waxTubeId}  waxSourceLot=${run.waxSourceLot}`);

	// --- 2. Verify every cartridge is past wax_filled (defensive) ---
	const carts = await db.collection('cartridge_records').find({
		_id: { $in: run.cartridgeIds ?? [] }
	}).project({ _id: 1, status: 1, 'waxStorage.recordedAt': 1 }).toArray();
	const BAD = (carts as any[]).filter(c => !c.waxStorage?.recordedAt || c.status === 'wax_filled' || c.status === 'wax_filling');
	if (BAD.length > 0) {
		console.error(`ABORT — ${BAD.length} cartridges haven't actually progressed past wax storage:`);
		for (const b of BAD) console.error(`  ${b._id}  status=${b.status}  waxStorage.recordedAt=${b.waxStorage?.recordedAt ?? 'unset'}`);
		process.exit(1);
	}
	console.log(`All ${carts.length} cartridges verified past wax storage. Proceeding.`);

	const cartridgeCount = (run.cartridgeIds ?? []).length;

	// --- 3. Set run status = completed ---
	await db.collection('wax_filling_runs').updateOne(
		{ _id: RUN_ID } as any,
		{ $set: { status: 'completed', runEndTime: now } }
	);
	console.log('Run marked completed.');

	// --- 4. Log deck usage ---
	if (run.deckId) {
		await db.collection('equipment').updateOne(
			{ _id: run.deckId } as any,
			{
				$set: { lastUsed: now },
				$push: {
					usageLog: {
						_id: nanoid(), usageType: 'run_complete', runId: run._id,
						quantityChanged: cartridgeCount, operator,
						notes: `Wax filling run complete — ${cartridgeCount} cartridges filled (admin override of stuck storage UI)`,
						createdAt: now
					}
				} as any
			}
		);
		console.log(`Deck ${run.deckId} usage logged.`);
	}

	// --- 5. Wax tube consumption (2ml incubator) ---
	if (run.waxTubeId) {
		const tubeLot = await db.collection('receiving_lots').findOne({ lotId: run.waxTubeId }) as any;
		if (tubeLot) {
			await db.collection('receiving_lots').updateOne({ _id: tubeLot._id }, { $inc: { quantity: -1 } });
			if (tubeLot.part?._id) {
				await db.collection('inventory_transactions').insertOne({
					_id: nanoid(),
					transactionType: 'consumption',
					partDefinitionId: tubeLot.part._id,
					lotId: tubeLot._id,
					quantity: 1,
					manufacturingStep: 'wax_filling',
					manufacturingRunId: run._id,
					operatorId: operator._id,
					operatorUsername: operator.username,
					notes: `Wax filling run — 2ml incubator tube consumed (lot ${run.waxTubeId}) [admin override]`,
					createdAt: now
				});
			}
			console.log(`Wax tube lot ${run.waxTubeId} decremented.`);
		} else {
			await db.collection('consumables').updateOne(
				{ _id: run.waxTubeId } as any,
				{
					$set: { lastUsedAt: now },
					$inc: { totalCartridgesFilled: cartridgeCount, totalRunsUsed: 1 },
					$push: {
						usageLog: {
							_id: nanoid(), usageType: 'wax_run', runId: run._id,
							quantityChanged: cartridgeCount, operator,
							notes: `Wax filling run complete — ${cartridgeCount} cartridges [admin override]`,
							createdAt: now
						}
					} as any
				}
			);
			console.log(`Consumable ${run.waxTubeId} usage logged.`);
		}
	}

	// --- 6. Wax source lot volume (15ml bottle) ---
	if (run.waxSourceLot) {
		const waxLot = await db.collection('receiving_lots').findOne({
			$or: [{ lotId: run.waxSourceLot }, { bagBarcode: run.waxSourceLot }, { lotNumber: run.waxSourceLot }]
		}) as any;
		if (waxLot) {
			const consumedBefore = Number(waxLot.consumedUl ?? 0);
			const capUl = Number(waxLot.quantity ?? 0) * FULL_TUBE_VOLUME_UL;
			const consumedAfter = Math.min(capUl, consumedBefore + WAX_FILL_VOLUME_UL);
			const tubesBefore = Math.floor(consumedBefore / FULL_TUBE_VOLUME_UL);
			const tubesAfter = Math.floor(consumedAfter / FULL_TUBE_VOLUME_UL);
			const tubesToDeduct = tubesAfter - tubesBefore;
			const update: any = { $set: { consumedUl: consumedAfter } };
			if (tubesToDeduct > 0) update.$inc = { quantity: -tubesToDeduct };
			await db.collection('receiving_lots').updateOne({ _id: waxLot._id }, update);
			if (tubesToDeduct > 0 && waxLot.part?._id) {
				await db.collection('inventory_transactions').insertOne({
					_id: nanoid(),
					transactionType: 'consumption',
					partDefinitionId: waxLot.part._id,
					lotId: waxLot._id,
					quantity: tubesToDeduct,
					manufacturingStep: 'wax_filling',
					manufacturingRunId: run._id,
					operatorId: operator._id,
					operatorUsername: operator.username,
					notes: `Wax filling — ${tubesToDeduct} × 15ml wax tube consumed (lot ${run.waxSourceLot}) [admin override]`,
					createdAt: now
				});
			}
			console.log(`Wax source lot ${run.waxSourceLot}: consumedUl ${consumedBefore} → ${consumedAfter} (${tubesToDeduct} tubes deducted).`);
		}
	}

	// --- 7. AuditLog ---
	await db.collection('audit_logs').insertOne({
		_id: nanoid(),
		tableName: 'wax_filling_runs',
		recordId: RUN_ID,
		action: 'UPDATE',
		changedBy: 'system-admin-override',
		changedAt: now,
		reason: `Stuck Storage-phase UI: cartridge 50ce9f00-bff6-42d3-ad14-b8540f4e5d9a had waxStorage.recordedAt already set AND status progressed to reagent_filled by downstream flow. recordBatchStorage write-once filter silently no-op'd operator clicks. All 24 cartridges verified past wax storage; marking run completed via admin override (mirrors completeRun side-effects).`,
		newData: { status: 'completed', cartridgeCount, manualOverride: true }
	});
	console.log('AuditLog row written.');

	await mongoose.disconnect();
	console.log('\nDone. Run should now disappear from the Storage queue.');
})();
