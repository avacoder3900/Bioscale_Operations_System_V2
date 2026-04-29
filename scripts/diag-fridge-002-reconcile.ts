/**
 * Reconcile the user's physical-count list of FRIDGE-002 cartridges against
 * what Mongo thinks is in FRIDGE-002.
 *
 *  - User listed 60 lines (59 unique, 1 duplicate) of cartridges they believe
 *    are currently in FRIDGE-002, as "scrapped or accepted".
 *  - Mongo's canonical view of active wax-stored occupancy returns 78
 *    (status='wax_stored' AND waxStorage.location='FRIDGE-002').
 *  - Mongo also has other statuses touching FRIDGE-002 (scrapped, completed,
 *    voided, underway).
 *
 * This script:
 *  1. Reports the user's list status breakdown + which are currently wax_stored.
 *  2. Shows Mongo-side wax_stored-in-FRIDGE-002 cartridges NOT in user's list
 *     (i.e., "Mongo thinks it's there, user says it isn't").
 *  3. Shows cartridges in user's list NOT currently wax_stored in FRIDGE-002
 *     (i.e., "user scanned it, but Mongo says it's elsewhere or different status").
 *  4. Groups by cooling tray and by wax-filling run for both sides.
 */
import fs from 'node:fs';
import path from 'node:path';
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

const hr = '='.repeat(72);

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const carts = db.collection('cartridge_records');
	const runs = db.collection('wax_filling_runs');

	// --- 1. Read user's list --------------------------------------------------
	const raw = fs.readFileSync(path.resolve('scripts/data/fridge-002-user-inventory-2026-04-23.txt'), 'utf8');
	const allLines = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
	const unique = Array.from(new Set(allLines));
	const dupCount = allLines.length - unique.length;
	console.log(`User list: ${allLines.length} lines, ${unique.length} unique (${dupCount} duplicate${dupCount === 1 ? '' : 's'})`);
	const dupes = allLines.filter((id, i, a) => a.indexOf(id) !== i);
	if (dupes.length) {
		console.log(`  duplicates:`);
		for (const d of Array.from(new Set(dupes))) console.log(`    ${d}`);
	}
	const userSet = new Set(unique);

	// --- 2. Fetch docs for user list -----------------------------------------
	const userDocs = await carts.find({ _id: { $in: unique } }).toArray() as any[];
	const userDocsById = new Map(userDocs.map((d) => [d._id, d]));
	const userMissing = unique.filter((id) => !userDocsById.has(id));
	console.log(`\nUser list docs found in Mongo: ${userDocs.length}/${unique.length}`);
	if (userMissing.length) {
		console.log(`  missing in Mongo (not found):`);
		for (const m of userMissing) console.log(`    ${m}`);
	}

	// Status + waxQc breakdown of user's list
	const statusCount: Record<string, number> = {};
	const waxQcCount: Record<string, number> = {};
	const userInFridge002: string[] = [];
	const userWithLocationElsewhere: { id: string; loc: string | null; status: string }[] = [];
	for (const d of userDocs) {
		statusCount[d.status ?? '(null)'] = (statusCount[d.status ?? '(null)'] ?? 0) + 1;
		const q = d.waxQc?.status ?? '(none)';
		waxQcCount[q] = (waxQcCount[q] ?? 0) + 1;
		const loc = d.waxStorage?.location ?? null;
		if (loc === 'FRIDGE-002') userInFridge002.push(d._id);
		else userWithLocationElsewhere.push({ id: d._id, loc, status: d.status });
	}
	console.log(`\nUser list — status breakdown:`);
	for (const [s, n] of Object.entries(statusCount)) console.log(`  ${s}: ${n}`);
	console.log(`\nUser list — waxQc.status breakdown:`);
	for (const [s, n] of Object.entries(waxQcCount)) console.log(`  ${s}: ${n}`);
	console.log(`\nUser list — waxStorage.location='FRIDGE-002' match: ${userInFridge002.length}`);
	console.log(`User list — waxStorage.location ≠ 'FRIDGE-002' (or unset):`);
	for (const u of userWithLocationElsewhere) {
		console.log(`    ${u.id}  loc=${u.loc}  status=${u.status}`);
	}

	// --- 3. Reconcile against Mongo's active FRIDGE-002 --------------------
	const active = await carts.find({
		'waxStorage.location': 'FRIDGE-002',
		status: 'wax_stored'
	}).toArray() as any[];
	const activeSet = new Set(active.map((c) => c._id));
	console.log(`\n${hr}\n Mongo vs user reconcile\n${hr}`);
	console.log(`Mongo active wax_stored in FRIDGE-002:  ${active.length}`);
	console.log(`User list unique IDs:                   ${unique.length}`);

	const inBothActive = unique.filter((id) => activeSet.has(id));
	const userOnly_notActive = unique.filter((id) => !activeSet.has(id));
	const mongoActive_notInUser = active.filter((c) => !userSet.has(c._id)).map((c) => c._id);

	console.log(`  in BOTH (Mongo active + user list):   ${inBothActive.length}`);
	console.log(`  in USER list but NOT Mongo-active:    ${userOnly_notActive.length}`);
	console.log(`  in MONGO active but NOT user list:    ${mongoActive_notInUser.length}`);

	// --- 4. Explain the "user only, not active" group (these are the
	//        scrapped/completed/voided ones, or not-in-FRIDGE-002)
	console.log(`\n${hr}\n User-listed but NOT Mongo-active (status / location / why)\n${hr}`);
	for (const id of userOnly_notActive) {
		const d = userDocsById.get(id);
		if (!d) { console.log(`  ${id}  [NOT IN MONGO]`); continue; }
		const loc = d.waxStorage?.location ?? '(none)';
		console.log(`  ${id}  status=${d.status}  waxStorage.location=${loc}  tray=${d.waxStorage?.coolingTrayId ?? '-'}  waxRun=${d.waxFilling?.runId ?? '-'}`);
	}

	// --- 5. Explain the "Mongo active, not user-listed" group
	console.log(`\n${hr}\n Mongo-active but NOT in user list (${mongoActive_notInUser.length})\n${hr}`);
	const missingFromUser = await carts.find({ _id: { $in: mongoActive_notInUser } }).toArray() as any[];
	for (const d of missingFromUser) {
		console.log(`  ${d._id}  tray=${d.waxStorage?.coolingTrayId ?? '(none)'}  waxRun=${d.waxFilling?.runId ?? '-'}  recordedAt=${d.waxStorage?.recordedAt?.toISOString?.() ?? d.waxStorage?.timestamp?.toISOString?.() ?? '-'}`);
	}

	// --- 6. Tray + run breakdown across BOTH sets --------------------------
	console.log(`\n${hr}\n Tray breakdown (for user-listed cartridges)\n${hr}`);
	const trayUser = new Map<string, number>();
	for (const d of userDocs) {
		const t = d.waxStorage?.coolingTrayId ?? '(no tray)';
		trayUser.set(t, (trayUser.get(t) ?? 0) + 1);
	}
	for (const [t, n] of [...trayUser.entries()].sort((a, b) => b[1] - a[1])) {
		console.log(`  ${t}: ${n}`);
	}

	console.log(`\n${hr}\n Tray breakdown (Mongo-active FRIDGE-002, all 78)\n${hr}`);
	const trayMongo = new Map<string, number>();
	for (const d of active) {
		const t = d.waxStorage?.coolingTrayId ?? '(no tray)';
		trayMongo.set(t, (trayMongo.get(t) ?? 0) + 1);
	}
	for (const [t, n] of [...trayMongo.entries()].sort((a, b) => b[1] - a[1])) {
		console.log(`  ${t}: ${n}`);
	}

	console.log(`\n${hr}\n Wax-filling-run breakdown (user-listed cartridges)\n${hr}`);
	const runUser = new Map<string, number>();
	for (const d of userDocs) {
		const r = d.waxFilling?.runId ?? '(no run)';
		runUser.set(r, (runUser.get(r) ?? 0) + 1);
	}
	for (const [r, n] of [...runUser.entries()].sort((a, b) => b[1] - a[1])) {
		// Look up run details
		if (r === '(no run)') { console.log(`  ${r}: ${n}`); continue; }
		const runDoc = await runs.findOne({ _id: r });
		const rd = runDoc as any;
		const robot = rd?.robot?.name ?? rd?.robotName ?? '-';
		const status = rd?.status ?? '-';
		const created = rd?.createdAt?.toISOString?.() ?? '-';
		console.log(`  ${r}: ${n}  robot=${robot}  status=${status}  createdAt=${created}`);
	}

	console.log(`\n${hr}\n Wax-filling-run breakdown (Mongo-active FRIDGE-002, all 78)\n${hr}`);
	const runMongo = new Map<string, number>();
	for (const d of active) {
		const r = d.waxFilling?.runId ?? '(no run)';
		runMongo.set(r, (runMongo.get(r) ?? 0) + 1);
	}
	for (const [r, n] of [...runMongo.entries()].sort((a, b) => b[1] - a[1])) {
		if (r === '(no run)') { console.log(`  ${r}: ${n}`); continue; }
		const runDoc = await runs.findOne({ _id: r });
		const rd = runDoc as any;
		const robot = rd?.robot?.name ?? rd?.robotName ?? '-';
		const status = rd?.status ?? '-';
		const created = rd?.createdAt?.toISOString?.() ?? '-';
		console.log(`  ${r}: ${n}  robot=${robot}  status=${status}  createdAt=${created}`);
	}

	await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
