/**
 * Check out the 20 "ghost" FRIDGE-002 cartridges (Mongo says wax_stored, user
 * couldn't physically find them on 2026-04-23).
 *
 * Two reason groups, per the user:
 *   Group A — 8 from wax run 6o29m5Jre1aqGTXJ-fZdL (Robot 2, TRAY-002, 2026-04-22):
 *     reason: "Zane Testing 4-21"
 *   Group B — the remaining 12 (10 from qnf7hfG3... + 1 from 4Z6AldZW... + 1 from h6-R5NfuP...):
 *     reason: "After 2 Days and we already have these many that vanished, time to do better"
 *
 * Semantics (per the corrected checkout model): each cartridge KEEPS its
 * status='wax_stored'. The action creates one ManualCartridgeRemoval doc per
 * cartridge (not grouped) + one AuditLog entry (action='CHECKOUT'). No
 * status change, no InventoryTransaction.
 *
 * Note: because status is preserved, these cartridges will continue to
 * appear in the active FRIDGE-002 occupancy count (query looks for
 * status='wax_stored' + waxStorage.location='FRIDGE-002'). That's a known
 * gap in the checkout model — the fridge queries need a secondary filter
 * for "checked out" to show the true physical count.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
import { generateId } from '../src/lib/server/db/utils.js';

const OPERATOR = 'system-checkout-2026-04-23';

const GROUP_A = {
	reason: 'Zane Testing 4-21',
	ids: [
		'19599c7b-3508-42dc-81d3-0779ac1122aa',
		'1de49a74-a5ec-49af-a961-48665d57e95b',
		'42d0da85-69bb-4d54-82c8-8820723b678e',
		'8517ae0d-7bc0-4678-ba21-9a73a84717e1',
		'aac434fd-6e87-4532-923f-8f2e16a20e66',
		'af5e9147-aeab-4305-8075-c1afe20a84f4',
		'e30d86bc-d659-45af-8201-e545a6ab1522',
		'e71b3ced-c6fc-46a9-8084-46dafad00ad2'
	]
};

const GROUP_B = {
	reason: 'After 2 Days and we already have these many that vanished, time to do better',
	ids: [
		// 10 from qnf7hfG3-k5ltHXXRdyP9 (Robot 1, 2026-04-16, no tray)
		'174343e4-a047-4ec3-8bed-2d225f9482e1',
		'264eea4f-04db-4d8a-b9d0-3f16bc3a2d6c',
		'266ca18e-3dd4-458b-8db1-d7bd5c6ae7e6',
		'35161724-4d24-47ab-bdeb-6cb012dd2f50',
		'59f90127-6d5e-4b68-a98b-bac58bd2a07d',
		'7e84153b-3b6e-4aa7-9a1b-1d310636d68e',
		'8ce686d5-d696-43c2-8c2b-a43a404aefc3',
		'b540931b-da51-471d-b0d9-b6e843c42908',
		'd0d0b0f2-7d24-4449-bf64-34e2c936ed83',
		'fba02fa9-d21d-495e-9337-3d62ec682f9b',
		// 1 from 4Z6AldZWCJ8EC_QG0pe2N (Robot 1, 2026-04-22, TRAY-003)
		'3cba1b22-aa17-47e9-94ab-0435a63a4664',
		// 1 from h6-R5NfuP_yx5Lb4AO4i1 (Robot 1, 2026-04-22, TRAY-004)
		'deff4822-62cb-4963-aff2-76934be4ffdd'
	]
};

async function checkoutGroup(
	db: any,
	groupName: string,
	reason: string,
	ids: string[],
	now: Date
) {
	console.log(`\nGroup ${groupName} — "${reason}"`);
	console.log(`  ${ids.length} cartridges`);
	const carts = db.collection('cartridge_records');
	const removals = db.collection('manual_cartridge_removals');
	const audits = db.collection('audit_logs');

	// Pre-check: confirm each is currently wax_stored and not already in a ManualCartridgeRemoval
	const docs = await carts.find({ _id: { $in: ids } }).project({ _id: 1, status: 1 }).toArray();
	const byId = new Map(docs.map((d: any) => [d._id, d]));
	const existing = await removals.find({ cartridgeIds: { $in: ids } }).project({ cartridgeIds: 1 }).toArray();
	const alreadyCheckedOut = new Set<string>();
	for (const r of existing as any[]) for (const cid of r.cartridgeIds ?? []) alreadyCheckedOut.add(cid);

	let skipped = 0, written = 0;
	for (const cid of ids) {
		const d = byId.get(cid) as any;
		if (!d) { console.log(`    ${cid}: NOT FOUND — skipping`); skipped++; continue; }
		if (d.status !== 'wax_stored') { console.log(`    ${cid}: status=${d.status} (expected wax_stored) — skipping`); skipped++; continue; }
		if (alreadyCheckedOut.has(cid)) { console.log(`    ${cid}: already has a ManualCartridgeRemoval doc — skipping`); skipped++; continue; }

		const removalId = generateId();
		await removals.insertOne({
			_id: removalId,
			cartridgeIds: [cid],
			reason,
			operator: { _id: OPERATOR, username: OPERATOR },
			removedAt: now,
			createdAt: now,
			updatedAt: now
		});
		await audits.insertOne({
			_id: generateId(),
			tableName: 'cartridge_records',
			recordId: cid,
			action: 'CHECKOUT',
			changedBy: OPERATOR,
			changedAt: now,
			newData: { checkedOut: true, removalGroupId: removalId, reason, backfilled: true },
			reason: `Manual checkout: ${reason}`
		});
		written++;
	}
	console.log(`  ManualCartridgeRemoval docs written: ${written}`);
	console.log(`  skipped (missing / wrong status / duplicate): ${skipped}`);
}

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const now = new Date();
	await checkoutGroup(db, 'A', GROUP_A.reason, GROUP_A.ids, now);
	await checkoutGroup(db, 'B', GROUP_B.reason, GROUP_B.ids, now);
	await mongoose.disconnect();
	console.log('\nDone.');
}
main().catch((e) => { console.error(e); process.exit(1); });
