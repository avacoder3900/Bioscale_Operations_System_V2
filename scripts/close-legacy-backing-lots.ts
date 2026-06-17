/**
 * WAX-FLOW-2 — close out legacy BackingLot aggregate buckets.
 *
 * The BackingLot aggregate is retired: cartridges now originate as individual
 * CartridgeRecords (status='backing') at the WI-01 oven scan. Existing
 * non-consumed BackingLots are displayed read-only ("legacy") on the
 * dashboards until the floor confirms the physical buckets are drained, at
 * which point this script marks them consumed so they drop out everywhere.
 *
 * Lists every BackingLot with status != 'consumed' (id / count / age). With
 * --execute it sets cartridgeCount=0 + status='consumed' on each and writes
 * one audit_log row per lot (action 'CLOSE_BUCKET', changedBy 'system-manual',
 * reason 'WAX-FLOW-2 legacy bucket closure').
 *
 * Usage:
 *   npx tsx scripts/close-legacy-backing-lots.ts             (dry-run, default — no writes)
 *   npx tsx scripts/close-legacy-backing-lots.ts --execute   (close the lots + write audit rows)
 */
import mongoose from 'mongoose';
import { nanoid } from 'nanoid';
import * as dotenv from 'dotenv';
dotenv.config();

const URI = process.env.MONGODB_URI;
if (!URI) { console.error('MONGODB_URI missing'); process.exit(1); }

const args = new Set(process.argv.slice(2));
const EXECUTE = args.has('--execute');
const DRY_RUN = !EXECUTE;

async function main() {
	await mongoose.connect(URI!);
	const db = mongoose.connection.db!;

	console.log(DRY_RUN ? '*** DRY RUN — no writes will occur ***' : '*** EXECUTE — writing changes ***');
	console.log();

	const lots = await db.collection('backing_lots')
		.find({ status: { $ne: 'consumed' } })
		.sort({ ovenEntryTime: 1 })
		.toArray();

	console.log(`Found ${lots.length} non-consumed BackingLot doc(s).`);
	const nowMs = Date.now();
	for (const lot of lots as any[]) {
		const entry = lot.ovenEntryTime ? new Date(lot.ovenEntryTime) : null;
		const ageDays = entry ? ((nowMs - entry.getTime()) / 86400000).toFixed(1) : '?';
		console.log(
			`  ${lot._id} · status=${lot.status ?? 'unknown'} · cartridgeCount=${lot.cartridgeCount ?? 0}` +
			` · age=${ageDays}d (entered ${entry ? entry.toISOString() : 'unknown'})` +
			` · oven=${lot.ovenLocationName ?? lot.ovenLocationId ?? '—'}`
		);
	}

	if (lots.length === 0) {
		console.log('Nothing to close.');
		await mongoose.disconnect();
		return;
	}

	if (DRY_RUN) {
		console.log('\nDry run complete. Re-run with --execute to close these lots.');
		await mongoose.disconnect();
		return;
	}

	// EXECUTE — close each lot and write one audit_log row per lot.
	const now = new Date();
	const audit = db.collection('audit_log');
	let closed = 0;
	for (const lot of lots as any[]) {
		await db.collection('backing_lots').updateOne(
			{ _id: lot._id },
			{ $set: { cartridgeCount: 0, status: 'consumed' } }
		);
		await audit.insertOne({
			_id: nanoid(),
			tableName: 'backing_lots',
			recordId: String(lot._id),
			action: 'CLOSE_BUCKET',
			changedBy: 'system-manual',
			changedAt: now,
			oldData: { status: lot.status ?? null, cartridgeCount: lot.cartridgeCount ?? 0 },
			newData: { status: 'consumed', cartridgeCount: 0 },
			reason: 'WAX-FLOW-2 legacy bucket closure'
		} as any);
		closed++;
		console.log(`  closed ${lot._id} (was status=${lot.status ?? 'unknown'}, count=${lot.cartridgeCount ?? 0})`);
	}

	const remaining = await db.collection('backing_lots').countDocuments({ status: { $ne: 'consumed' } });
	console.log(`\nClosed ${closed} lot(s); wrote ${closed} audit_log row(s).`);
	console.log(`Non-consumed BackingLots remaining: ${remaining}`);

	await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
