import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
const URI = process.env.MONGODB_URI!;

// Matches the page-server classifier in src/routes/manufacturing/opentron-control/+page.server.ts
const TERMINAL_WAX = new Set(['completed', 'aborted', 'cancelled', 'voided',
	'Completed', 'Aborted', 'Cancelled', 'Voided']);
const WAX_FILLING_PAGE_STAGES = new Set([
	'Setup', 'Loading', 'Running', 'Awaiting Removal',
	'setup', 'loading', 'running', 'awaiting_removal', 'cooling'
]);

async function main() {
	await mongoose.connect(URI);
	const db = mongoose.connection.db!;

	const allWaxRuns = await db.collection('wax_filling_runs').find({
		status: { $nin: [...TERMINAL_WAX] }
	}).sort({ createdAt: -1 }).toArray();

	const postProcessingRuns = (allWaxRuns as any[]).filter(r => !WAX_FILLING_PAGE_STAGES.has(r.status));

	console.log(`\n=== Wax post-OT-2 runs (QC + Storage stages) — ${postProcessingRuns.length} runs ===\n`);

	let totalCartridgeIds = 0;
	const allCartridgeIds: string[] = [];
	for (const r of postProcessingRuns) {
		const ids: string[] = r.cartridgeIds ?? [];
		totalCartridgeIds += ids.length;
		allCartridgeIds.push(...ids);
		console.log(`run=${r._id}  status=${r.status}  robot=${r.robot?.name ?? r.robot?._id ?? '(?)'}  cartridgeIds.length=${ids.length}  planned=${r.plannedCartridgeCount ?? '?'}  runStartTime=${r.runStartTime?.toISOString?.() ?? r.runStartTime ?? '(none)'}`);
	}
	console.log(`\nSum of cartridgeIds across post-processing runs: ${totalCartridgeIds}`);

	if (allCartridgeIds.length === 0) {
		console.log('\nNo cartridge IDs in any post-processing run. Exiting.');
		await mongoose.disconnect();
		return;
	}

	const carts = await db.collection('cartridge_records').find(
		{ _id: { $in: allCartridgeIds } },
		{ projection: { _id: 1, status: 1, 'waxFilling.runId': 1, 'backing.lotId': 1, 'waxQc.status': 1, 'waxQc.timestamp': 1, 'waxStorage.location': 1, 'waxStorage.timestamp': 1, updatedAt: 1 } }
	).toArray();

	console.log(`\n=== Cartridges in those runs — found ${carts.length} of ${allCartridgeIds.length} referenced IDs ===\n`);

	const byRun = new Map<string, any[]>();
	for (const c of carts as any[]) {
		const rid = String(c.waxFilling?.runId ?? '(no runId)');
		if (!byRun.has(rid)) byRun.set(rid, []);
		byRun.get(rid)!.push(c);
	}

	for (const r of postProcessingRuns) {
		const rid = String(r._id);
		const list = byRun.get(rid) ?? [];
		console.log(`\n--- run ${rid}  (${r.status}) ---`);
		for (const c of list) {
			console.log(`  ${c._id}  status=${c.status}  backingLot=${c.backing?.lotId ?? '—'}  qc=${c.waxQc?.status ?? '—'}  stored=${c.waxStorage?.location ?? '—'}`);
		}
	}

	const statusAgg: Record<string, number> = {};
	for (const c of carts as any[]) {
		statusAgg[c.status ?? '(none)'] = (statusAgg[c.status ?? '(none)'] ?? 0) + 1;
	}
	console.log(`\n=== Aggregate status counts across all post-processing cartridges ===`);
	console.log(JSON.stringify(statusAgg, null, 2));
	console.log(`\nTotal cartridge records returned: ${carts.length}`);

	await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
