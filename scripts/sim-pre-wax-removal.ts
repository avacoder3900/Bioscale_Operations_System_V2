/**
 * Simulate the pre-wax (backing-lot) removal flow end-to-end.
 *
 * Replicates the logic of the removeFromBackingLot action in
 * src/routes/manufacturing/scrap/+page.server.ts against a synthetic test
 * BackingLot, then cleans up. Verifies:
 *   1. happy path: count decrements, ManualCartridgeRemoval + AuditLog written
 *   2. over-pull: rejected with helpful error, no DB mutations
 *   3. drain: status flips to 'consumed' when count reaches 0
 *   4. drained-lot guard: further pulls rejected
 *
 * Usage: npx tsx scripts/sim-pre-wax-removal.ts
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

const URI = process.env.MONGODB_URI;
if (!URI) { console.error('MONGODB_URI missing'); process.exit(1); }

const SIM_LOT_ID = `SIM-BL-${Date.now()}`;
const SIM_OPERATOR = { _id: 'sim-operator-id', username: 'sim-operator' };

function generateId(): string {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
	let id = '';
	for (let i = 0; i < 21; i++) id += alphabet[Math.floor(Math.random() * alphabet.length)];
	return id;
}

interface RemoveResult {
	ok: boolean;
	error?: string;
	removalId?: string;
	count?: number;
	remaining?: number;
	consumed?: boolean;
}

async function removeFromBackingLot(
	db: any,
	lotBarcode: string,
	count: number,
	reason: string
): Promise<RemoveResult> {
	if (!lotBarcode) return { ok: false, error: 'Scan the backing lot barcode' };
	if (!Number.isInteger(count) || count <= 0) return { ok: false, error: 'Count must be a positive whole number' };
	if (!reason) return { ok: false, error: 'Reason is required' };

	const updatedLot = await db.collection('backing_lots').findOneAndUpdate(
		{ _id: lotBarcode, cartridgeCount: { $gte: count } },
		{ $inc: { cartridgeCount: -count } },
		{ returnDocument: 'after' }
	);

	if (!updatedLot) {
		const current = await db.collection('backing_lots').findOne({ _id: lotBarcode });
		if (!current) return { ok: false, error: `Backing lot "${lotBarcode}" not found` };
		return {
			ok: false,
			error: `Backing lot ${lotBarcode} has only ${current.cartridgeCount ?? 0} cartridge(s) remaining (status=${current.status ?? 'unknown'}); cannot remove ${count}.`
		};
	}

	const now = new Date();
	const remainingAfter = updatedLot.cartridgeCount ?? 0;

	if (remainingAfter <= 0) {
		await db.collection('backing_lots').updateOne(
			{ _id: lotBarcode },
			{ $set: { cartridgeCount: 0, status: 'consumed' } }
		);
	}

	const removalId = generateId();
	await db.collection('manual_cartridge_removals').insertOne({
		_id: removalId,
		cartridgeIds: [],
		cartridgeCount: count,
		backingLotId: lotBarcode,
		reason,
		operator: SIM_OPERATOR,
		removedAt: now,
		createdAt: now,
		updatedAt: now
	});

	await db.collection('audit_log').insertOne({
		_id: generateId(),
		tableName: 'backing_lots',
		recordId: lotBarcode,
		action: 'CHECKOUT',
		changedBy: SIM_OPERATOR.username,
		changedAt: now,
		oldData: { cartridgeCount: remainingAfter + count },
		newData: { cartridgeCount: remainingAfter, removalGroupId: removalId, count, reason },
		reason: `Manual pre-wax removal: ${reason}`
	});

	return {
		ok: true,
		removalId,
		count,
		remaining: remainingAfter,
		consumed: remainingAfter <= 0
	};
}

function pass(msg: string) { console.log(`  ✓ ${msg}`); }
function fail(msg: string): never { console.error(`  ✗ ${msg}`); process.exit(1); }

async function main() {
	await mongoose.connect(URI!);
	const db = mongoose.connection.db!;
	console.log(`Test lot id: ${SIM_LOT_ID}\n`);

	// Setup: create a synthetic BackingLot with 10 cartridges, status 'in_oven'.
	await db.collection('backing_lots').insertOne({
		_id: SIM_LOT_ID,
		lotType: 'backing',
		cartridgeCount: 10,
		status: 'in_oven',
		ovenEntryTime: new Date(),
		ovenLocationId: 'sim-oven',
		ovenLocationName: 'Simulation Oven',
		operator: SIM_OPERATOR,
		createdAt: new Date(),
		updatedAt: new Date()
	} as any);
	console.log(`Setup: BackingLot ${SIM_LOT_ID} created with cartridgeCount=10, status=in_oven\n`);

	const removalIds: string[] = [];

	try {
		// --- Test 1: happy path ---
		console.log('Test 1: remove 3 from a 10-count lot');
		const r1 = await removeFromBackingLot(db, SIM_LOT_ID, 3, 'sim test 1');
		if (!r1.ok) fail(`expected success, got error: ${r1.error}`);
		pass(`action returned ok, removalId=${r1.removalId}`);
		if (r1.count !== 3) fail(`expected count=3, got ${r1.count}`);
		pass(`count=3`);
		if (r1.remaining !== 7) fail(`expected remaining=7, got ${r1.remaining}`);
		pass(`remaining=7`);
		if (r1.consumed !== false) fail(`expected consumed=false, got ${r1.consumed}`);
		pass(`consumed=false`);
		removalIds.push(r1.removalId!);

		const lot1 = await db.collection('backing_lots').findOne({ _id: SIM_LOT_ID });
		if (lot1?.cartridgeCount !== 7) fail(`DB cartridgeCount expected 7, got ${lot1?.cartridgeCount}`);
		pass(`DB cartridgeCount=7`);
		if (lot1?.status !== 'in_oven') fail(`DB status expected 'in_oven', got '${lot1?.status}'`);
		pass(`DB status=in_oven`);

		const removal1 = await db.collection('manual_cartridge_removals').findOne({ _id: r1.removalId });
		if (!removal1) fail('ManualCartridgeRemoval not written');
		pass('ManualCartridgeRemoval row written');
		if (removal1.backingLotId !== SIM_LOT_ID) fail(`removal.backingLotId expected ${SIM_LOT_ID}, got ${removal1.backingLotId}`);
		if (removal1.cartridgeCount !== 3) fail(`removal.cartridgeCount expected 3, got ${removal1.cartridgeCount}`);
		if (removal1.cartridgeIds?.length !== 0) fail(`removal.cartridgeIds expected [], got ${JSON.stringify(removal1.cartridgeIds)}`);
		if (removal1.reason !== 'sim test 1') fail(`removal.reason mismatch`);
		pass('ManualCartridgeRemoval has correct fields (backingLotId, cartridgeCount=3, ids=[], reason)');

		const audit1 = await db.collection('audit_log').findOne({
			tableName: 'backing_lots', recordId: SIM_LOT_ID, 'newData.removalGroupId': r1.removalId
		});
		if (!audit1) fail('AuditLog CHECKOUT entry not written');
		if (audit1.action !== 'CHECKOUT') fail(`audit.action expected CHECKOUT, got ${audit1.action}`);
		pass('AuditLog CHECKOUT entry written');

		// --- Test 2: over-pull rejection ---
		console.log('\nTest 2: try to remove 100 from a 7-count lot');
		const r2 = await removeFromBackingLot(db, SIM_LOT_ID, 100, 'sim over-pull');
		if (r2.ok) fail('expected rejection, got success');
		pass(`rejected with: ${r2.error}`);
		if (!r2.error?.includes('only 7')) fail(`error should mention "only 7", got: ${r2.error}`);
		pass('error message mentions remaining count (7)');

		const lot2 = await db.collection('backing_lots').findOne({ _id: SIM_LOT_ID });
		if (lot2?.cartridgeCount !== 7) fail(`cartridgeCount mutated on rejection: now ${lot2?.cartridgeCount}`);
		pass('cartridgeCount unchanged after rejection (still 7)');

		const phantomRemovals = await db.collection('manual_cartridge_removals').countDocuments({
			backingLotId: SIM_LOT_ID, reason: 'sim over-pull'
		});
		if (phantomRemovals !== 0) fail(`expected 0 phantom removal rows, got ${phantomRemovals}`);
		pass('no phantom ManualCartridgeRemoval written on rejection');

		// --- Test 3: drain-to-zero flips status to 'consumed' ---
		console.log('\nTest 3: remove the remaining 7 (drain)');
		const r3 = await removeFromBackingLot(db, SIM_LOT_ID, 7, 'sim drain');
		if (!r3.ok) fail(`expected success, got error: ${r3.error}`);
		if (r3.remaining !== 0) fail(`expected remaining=0, got ${r3.remaining}`);
		if (r3.consumed !== true) fail(`expected consumed=true, got ${r3.consumed}`);
		pass(`drained: remaining=0, consumed=true`);
		removalIds.push(r3.removalId!);

		const lot3 = await db.collection('backing_lots').findOne({ _id: SIM_LOT_ID });
		if (lot3?.cartridgeCount !== 0) fail(`DB cartridgeCount expected 0, got ${lot3?.cartridgeCount}`);
		if (lot3?.status !== 'consumed') fail(`DB status expected 'consumed', got '${lot3?.status}'`);
		pass(`DB cartridgeCount=0, status=consumed`);

		// --- Test 4: drained lot guard ---
		console.log('\nTest 4: try to remove 1 from a drained lot');
		const r4 = await removeFromBackingLot(db, SIM_LOT_ID, 1, 'sim post-drain');
		if (r4.ok) fail('expected rejection on drained lot, got success');
		pass(`rejected with: ${r4.error}`);
		if (!r4.error?.includes('only 0') || !r4.error.includes('consumed')) {
			fail(`error should mention "only 0" + "consumed", got: ${r4.error}`);
		}
		pass('error message reflects 0 remaining + consumed status');

		// --- Test 5: not-found guard ---
		console.log('\nTest 5: try to remove from a nonexistent lot');
		const r5 = await removeFromBackingLot(db, 'BL-DOES-NOT-EXIST-ZZZ', 1, 'sim missing');
		if (r5.ok) fail('expected rejection, got success');
		pass(`rejected with: ${r5.error}`);
		if (!r5.error?.includes('not found')) fail(`error should mention 'not found', got: ${r5.error}`);
		pass('error message mentions not found');

		// --- Test 6: validation guards ---
		console.log('\nTest 6: validation (no barcode / bad count / no reason)');
		const v1 = await removeFromBackingLot(db, '', 1, 'r');
		if (v1.ok || !v1.error?.includes('barcode')) fail(`empty barcode should be rejected, got ${JSON.stringify(v1)}`);
		pass(`empty barcode rejected: ${v1.error}`);
		const v2 = await removeFromBackingLot(db, SIM_LOT_ID, 0, 'r');
		if (v2.ok || !v2.error?.includes('positive')) fail(`zero count should be rejected, got ${JSON.stringify(v2)}`);
		pass(`zero count rejected: ${v2.error}`);
		const v3 = await removeFromBackingLot(db, SIM_LOT_ID, 1.5, 'r');
		if (v3.ok || !v3.error?.includes('whole')) fail(`fractional count should be rejected, got ${JSON.stringify(v3)}`);
		pass(`fractional count rejected: ${v3.error}`);
		const v4 = await removeFromBackingLot(db, SIM_LOT_ID, 1, '');
		if (v4.ok || !v4.error?.includes('Reason')) fail(`empty reason should be rejected, got ${JSON.stringify(v4)}`);
		pass(`empty reason rejected: ${v4.error}`);

		// --- Final summary ---
		console.log('\n--- Summary ---');
		const finalLot = await db.collection('backing_lots').findOne({ _id: SIM_LOT_ID });
		console.log(`final BackingLot: cartridgeCount=${finalLot?.cartridgeCount}, status=${finalLot?.status}`);
		const removalCount = await db.collection('manual_cartridge_removals').countDocuments({ backingLotId: SIM_LOT_ID });
		console.log(`ManualCartridgeRemoval rows for sim lot: ${removalCount}`);
		const auditCount = await db.collection('audit_log').countDocuments({ tableName: 'backing_lots', recordId: SIM_LOT_ID });
		console.log(`AuditLog rows for sim lot: ${auditCount}`);
	} finally {
		// Cleanup: delete simulated artifacts
		console.log('\n--- Cleanup ---');
		await db.collection('backing_lots').deleteOne({ _id: SIM_LOT_ID });
		const delRemovals = await db.collection('manual_cartridge_removals').deleteMany({ backingLotId: SIM_LOT_ID });
		const delAudits = await db.collection('audit_log').deleteMany({ tableName: 'backing_lots', recordId: SIM_LOT_ID });
		console.log(`Deleted: 1 BackingLot, ${delRemovals.deletedCount} ManualCartridgeRemovals, ${delAudits.deletedCount} AuditLogs`);
	}

	await mongoose.disconnect();
	console.log('\nALL TESTS PASSED ✓');
}

main().catch(err => { console.error(err); process.exit(1); });
