import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

const URI = process.env.MONGODB_URI;
if (!URI) { console.error('MONGODB_URI missing'); process.exit(1); }

async function main() {
	await mongoose.connect(URI!);
	const db = mongoose.connection.db!;

	// 1. Most recent ManualCartridgeRemoval — what was just checked out?
	const recent = await db.collection('manual_cartridge_removals')
		.find({})
		.sort({ removedAt: -1 })
		.limit(3)
		.toArray();

	console.log('=== 3 most recent ManualCartridgeRemoval entries ===');
	for (const r of recent) {
		console.log(`\n  id: ${r._id}`);
		console.log(`  removedAt: ${r.removedAt?.toISOString?.() ?? r.removedAt}`);
		console.log(`  operator: ${r.operator?.username ?? r.operator?._id ?? '?'}`);
		console.log(`  reason: ${JSON.stringify(r.reason)}`);
		console.log(`  cartridgeIds (${(r.cartridgeIds ?? []).length}): ${JSON.stringify(r.cartridgeIds)}`);
		if (r.backingLotId) console.log(`  backingLotId: ${r.backingLotId}  cartridgeCount: ${r.cartridgeCount}`);
	}

	// 2. For the very latest one, pull each cartridge and confirm status preserved
	const latest = recent[0];
	if (!latest || !latest.cartridgeIds || latest.cartridgeIds.length === 0) {
		console.log('\n(no cart-id-based removal found at top — stopping)');
		await mongoose.disconnect();
		return;
	}

	console.log(`\n=== CartridgeRecord state for the ${latest.cartridgeIds.length} carts in latest removal ===`);
	const carts = await db.collection('cartridge_records')
		.find({ _id: { $in: latest.cartridgeIds } })
		.project({ _id: 1, status: 1, 'waxStorage.location': 1, 'waxStorage.locationId': 1,
			'waxFilling.runId': 1, 'reagentFilling.assayType.name': 1, 'storage.fridgeName': 1,
			updatedAt: 1 })
		.toArray();

	for (const c of carts) {
		console.log(`  ${c._id}`);
		console.log(`    status: ${c.status}`);
		console.log(`    waxStorage.location: ${c.waxStorage?.location ?? '—'}`);
		console.log(`    waxFilling.runId: ${c.waxFilling?.runId ?? '—'}`);
		console.log(`    storage.fridgeName: ${c.storage?.fridgeName ?? '—'}`);
		console.log(`    updatedAt: ${c.updatedAt?.toISOString?.() ?? c.updatedAt}`);
	}

	const found = new Set(carts.map((c: any) => c._id));
	const missing = latest.cartridgeIds.filter((id: string) => !found.has(id));
	if (missing.length > 0) {
		console.log(`  MISSING (not found in cartridge_records): ${JSON.stringify(missing)}`);
	}

	// 3. AuditLog entries for these carts — should have CHECKOUT action with statusAtCheckout
	console.log(`\n=== AuditLog CHECKOUT entries for these carts ===`);
	const audits = await db.collection('audit_log')
		.find({ recordId: { $in: latest.cartridgeIds }, action: 'CHECKOUT' })
		.sort({ changedAt: -1 })
		.toArray();

	console.log(`Found ${audits.length} audit entries (expected ${latest.cartridgeIds.length})`);
	for (const a of audits) {
		console.log(`  cart=${a.recordId}  by=${a.changedBy}  at=${a.changedAt?.toISOString?.() ?? a.changedAt}`);
		console.log(`    statusAtCheckout: ${a.newData?.statusAtCheckout ?? '(NOT RECORDED)'}`);
		console.log(`    removalGroupId: ${a.newData?.removalGroupId}`);
		console.log(`    reason: ${a.newData?.reason}`);
	}

	// 4. Sanity: are these carts now excluded from the wax_filled count?
	console.log(`\n=== Count consistency check ===`);
	// Get all checked-out IDs across all removals (mirrors getCheckedOutCartridgeIds)
	const allRemovals = await db.collection('manual_cartridge_removals')
		.find({}, { projection: { cartridgeIds: 1 } } as any).toArray();
	const checkedOutIds = Array.from(new Set(
		allRemovals.flatMap((r: any) => r.cartridgeIds ?? [])
	));
	console.log(`Total checked-out cart IDs across history: ${checkedOutIds.length}`);

	const waxFilledTotal = await db.collection('cartridge_records')
		.countDocuments({ status: 'wax_filled' });
	const waxFilledMinusCheckout = await db.collection('cartridge_records')
		.countDocuments({ status: 'wax_filled', _id: { $nin: checkedOutIds } });
	console.log(`status=wax_filled total: ${waxFilledTotal}`);
	console.log(`status=wax_filled excluding checked-out: ${waxFilledMinusCheckout}`);
	console.log(`difference (carts removed by checkout from wax_filled): ${waxFilledTotal - waxFilledMinusCheckout}`);

	// Also check completed for context
	const completedTotal = await db.collection('cartridge_records')
		.countDocuments({ status: 'completed' });
	const completedMinusCheckout = await db.collection('cartridge_records')
		.countDocuments({ status: 'completed', _id: { $nin: checkedOutIds } });
	console.log(`\nstatus=completed total: ${completedTotal}`);
	console.log(`status=completed excluding checked-out: ${completedMinusCheckout}`);

	await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
