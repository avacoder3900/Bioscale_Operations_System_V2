/**
 * READ-ONLY audit of in-process cartridges (bucket → wax → reagent).
 *
 * Cross-checks every cart's `status` against the thing that is supposed to own
 * it at that stage (open bucket pass, wax run, reagent run) and against its own
 * phase sub-documents. Writes nothing. Re-runnable.
 *
 *   npx tsx scripts/diag-inprocess-cart-audit.ts [--json <path>]
 *
 * Pipeline (BUCKET-SYSTEM_PLAN.md §2, cartridge-wax-status.ts, REAGENT-TOPSEAL-IMPLICIT):
 *   barcoded → unpressed → backing → wax_filling → wax_filled → reagent_filling
 *   → reagent_filled → reagent_qc → reagent_ready → stored → released → shipped
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import { writeFileSync } from 'node:fs';
dotenv.config();

const KNOWN_STATUSES = [
	'barcoded', 'unpressed', 'pressed', 'backing', 'wax_filling', 'wax_filled', 'wax_qc', 'wax_ready',
	'wax_rejected', 'reagent_filling', 'reagent_filled', 'sealed', 'reagent_qc', 'reagent_ready',
	'reagent_rejected', 'stored', 'released', 'shipped', 'linked', 'underway', 'completed', 'cancelled',
	'scrapped', 'voided', 'packeted', 'transferred', 'received'
];
const LEGACY_STATUSES = ['raw', 'pressed', 'wax_stored', 'wax_qc', 'sealed'];
const BUCKET_STATUSES = ['barcoded', 'raw', 'unpressed', 'pressed'];
const PRE_WAX = [...BUCKET_STATUSES, 'backing'];
const IN_PROCESS = [...PRE_WAX, 'wax_filling', 'wax_filled', 'wax_ready', 'wax_stored', 'wax_qc',
	'reagent_filling', 'reagent_filled', 'sealed', 'reagent_qc', 'reagent_ready'];
const WAX_NON_TERMINAL = ['Setup', 'Loading', 'Running', 'Awaiting Removal', 'QC', 'Storage',
	'setup', 'loading', 'running', 'awaiting_removal', 'cooling', 'qc', 'storage'];
const REAGENT_NON_TERMINAL = ['Setup', 'Loading', 'Running', 'Inspection', 'Top Sealing', 'Storage',
	'setup', 'loading', 'running', 'inspection', 'top_sealing', 'storage'];

const DAY = 86_400_000;
const now = Date.now();
const ageDays = (d: unknown) => (d ? Math.floor((now - new Date(d as any).getTime()) / DAY) : null);
const day = (d: unknown) => (d ? new Date(d as any).toISOString().slice(0, 10) : '—');
const hist = <T,>(rows: T[], key: (r: T) => string) => {
	const m = new Map<string, number>();
	for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + 1);
	return [...m.entries()].sort((a, b) => b[1] - a[1]);
};
const ageBucket = (d: unknown) => {
	const a = ageDays(d);
	if (a === null) return 'no date';
	return a <= 1 ? '0-1d' : a <= 7 ? '2-7d' : a <= 14 ? '8-14d' : a <= 30 ? '15-30d' : a <= 60 ? '31-60d' : '60d+';
};
const AGE_ORDER = ['0-1d', '2-7d', '8-14d', '15-30d', '31-60d', '60d+', 'no date'];
const ageLine = (rows: any[]) => {
	const h = new Map(hist(rows, r => ageBucket(r.updatedAt)));
	return AGE_ORDER.filter(k => h.has(k)).map(k => `${k}: ${h.get(k)}`).join('  ');
};
const sample = (ids: string[], n = 8) => ids.slice(0, n).join(', ') + (ids.length > n ? `, … (+${ids.length - n})` : '');
const h1 = (s: string) => console.log(`\n${'='.repeat(78)}\n${s}\n${'='.repeat(78)}`);

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	console.log(`db: ${db.databaseName} @ ${mongoose.connection.host}   ${new Date().toISOString()}   (read-only)`);
	const carts = db.collection('cartridge_records');
	const findings: Record<string, unknown> = {};
	const flag = (key: string, title: string, rows: any[]) => {
		findings[key] = rows;
		console.log(`  [${rows.length ? '!!' : 'ok'}] ${title}: ${rows.length}`);
	};

	// ---- 0. status histogram -------------------------------------------------
	h1('0. STATUS HISTOGRAM (all carts)');
	const statusHist = await carts.aggregate([
		{ $group: { _id: '$status', n: { $sum: 1 }, oldest: { $min: '$updatedAt' }, newest: { $max: '$updatedAt' } } },
		{ $sort: { n: -1 } }
	]).toArray();
	for (const r of statusHist as any[]) {
		const tag = r._id == null ? '  <-- NO STATUS' : !KNOWN_STATUSES.includes(r._id) ? '  <-- NOT IN ENUM' : LEGACY_STATUSES.includes(r._id) ? '  <-- legacy/retired' : '';
		console.log(`  ${String(r._id ?? '<null>').padEnd(18)} ${String(r.n).padStart(6)}   updated ${day(r.oldest)} … ${day(r.newest)}${tag}`);
	}
	findings.statusHistogram = statusHist;

	// ---- load every in-process cart -----------------------------------------
	const proj = {
		status: 1, priorStatus: 1, statusUpdatedOn: 1, updatedAt: 1, createdAt: 1, used: 1, voidedAt: 1, usedForTestFill: 1,
		assayCategory: 1,
		'bucket.bucketId': 1, 'bucket.cycleId': 1,
		'backing.recordedAt': 1, 'backing.manualBackedAt': 1, 'backing.lotId': 1, 'backing.bucketCycleId': 1,
		'waxFilling.runId': 1, 'waxFilling.runEndTime': 1, 'waxFilling.recordedAt': 1,
		'waxQc.status': 1,
		'waxStorage.locationId': 1, 'waxStorage.location': 1, 'waxStorage.recordedAt': 1,
		'reagentFilling.runId': 1, 'reagentFilling.fillDate': 1, 'reagentFilling.recordedAt': 1, 'reagentFilling.expirationDate': 1,
		'reagentInspection.status': 1,
		'storage.fridgeId': 1, 'storage.recordedAt': 1,
		'testExecution.executedAt': 1, 'testResult.status': 1
	};
	const wip = await carts.find({ $or: [{ status: { $in: IN_PROCESS } }, { status: null }, { status: { $nin: KNOWN_STATUSES } }] }, { projection: proj }).toArray() as any[];
	const byStatus = (s: string | string[]) => wip.filter(c => (Array.isArray(s) ? s.includes(c.status) : c.status === s));
	const slim = (c: any, extra: Record<string, unknown> = {}) => ({ _id: c._id, status: c.status, priorStatus: c.priorStatus ?? null, updatedAt: c.updatedAt ?? null, ...extra });

	h1('1. IN-PROCESS AGE (by last update)');
	for (const s of IN_PROCESS) {
		const rows = byStatus(s);
		if (rows.length) console.log(`  ${s.padEnd(18)} ${String(rows.length).padStart(6)}   ${ageLine(rows)}`);
	}

	// ---- 2. buckets ----------------------------------------------------------
	h1('2. BUCKETS ↔ CARTS');
	const openCycles = await db.collection('bucket_cycles').find({ status: 'open' }).toArray() as any[];
	const buckets = await db.collection('production_buckets').find({}).toArray() as any[];
	console.log(`  open passes: ${openCycles.length}   buckets: ${buckets.length}  (${hist(buckets, b => b.state ?? '<null>').map(([k, n]) => `${k} ${n}`).join(', ')})`);
	for (const [stage, n] of hist(openCycles, c => c.stage)) {
		const members = openCycles.filter(c => c.stage === stage).reduce((a, c) => a + (c.cartridgeIds?.length ?? 0), 0);
		console.log(`    stage ${stage}: ${n} pass(es), ${members} member cart(s)`);
	}
	const memberOf = new Map<string, any[]>();
	for (const c of openCycles) for (const id of c.cartridgeIds ?? []) memberOf.set(id, [...(memberOf.get(id) ?? []), c]);
	const memberIds = [...memberOf.keys()];
	const memberCarts = new Map<string, any>((await carts.find({ _id: { $in: memberIds } as any }, { projection: proj }).toArray()).map((c: any) => [c._id, c]));
	const cyc = (c: any) => `${c.bucketId} #${c.cycleNumber}`;

	flag('bucket_member_status_mismatch', 'member of an open pass but cart status ≠ pass stage',
		memberIds.filter(id => memberCarts.has(id) && memberCarts.get(id).status !== memberOf.get(id)![0].stage)
			.map(id => slim(memberCarts.get(id), { pass: cyc(memberOf.get(id)![0]), cycleId: memberOf.get(id)![0]._id, passStage: memberOf.get(id)![0].stage })));
	flag('bucket_member_no_record', 'member of an open pass but no cartridge record exists',
		memberIds.filter(id => !memberCarts.has(id)).map(id => ({ _id: id, pass: cyc(memberOf.get(id)![0]), cycleId: memberOf.get(id)![0]._id })));
	flag('bucket_member_multi', 'cart is a member of more than one open pass',
		memberIds.filter(id => memberOf.get(id)!.length > 1).map(id => ({ _id: id, passes: memberOf.get(id)!.map(cyc) })));
	flag('bucket_member_backref_mismatch', 'member cart whose bucket.cycleId points at a different pass',
		memberIds.filter(id => memberCarts.has(id) && memberCarts.get(id).bucket?.cycleId && memberCarts.get(id).bucket.cycleId !== memberOf.get(id)![0]._id)
			.map(id => slim(memberCarts.get(id), { pass: cyc(memberOf.get(id)![0]), cartCycleId: memberCarts.get(id).bucket.cycleId })));
	flag('bucket_qty_mismatch', 'open pass whose quantity ≠ member count',
		openCycles.filter(c => c.quantity !== (c.cartridgeIds?.length ?? 0)).map(c => ({ cycleId: c._id, pass: cyc(c), stage: c.stage, quantity: c.quantity, members: c.cartridgeIds?.length ?? 0 })));
	flag('bucket_orphan_carts', 'cart at a bucket stage (barcoded/unpressed/pressed/raw) but in NO open pass — stranded, nothing can advance it',
		byStatus(BUCKET_STATUSES).filter(c => !memberOf.has(c._id)).map(c => slim(c, { bucketId: c.bucket?.bucketId ?? null, cycleId: c.bucket?.cycleId ?? null })));
	flag('bucket_empty_open_pass', 'open pass with zero members',
		openCycles.filter(c => !(c.cartridgeIds?.length)).map(c => ({ cycleId: c._id, pass: cyc(c), stage: c.stage, openedAt: c.openedAt, stageEnteredAt: c.stageEnteredAt })));
	const openByBucket = new Map(openCycles.map(c => [c.bucketId, c]));
	flag('bucket_state_mismatch', 'bucket state disagrees with its open pass (in_use ⇔ exactly one open pass, currentCycleId = that pass)',
		buckets.filter(b => {
			const o = openByBucket.get(b._id);
			if (b.state === 'retired') return !!o;
			return o ? (b.state !== 'in_use' || b.currentCycleId !== o._id) : (b.state === 'in_use' || !!b.currentCycleId);
		}).map(b => ({ bucketId: b._id, nickname: b.nickname ?? null, state: b.state, currentCycleId: b.currentCycleId ?? null, openCycleId: openByBucket.get(b._id)?._id ?? null })));
	flag('bucket_open_pass_no_bucket', 'open pass whose bucket does not exist',
		openCycles.filter(c => !buckets.some(b => b._id === c.bucketId)).map(c => ({ cycleId: c._id, pass: cyc(c) })));
	flag('bucket_legacy_stage_pass', "open pass still at a retired stage (raw / pressed / qr_pending)",
		openCycles.filter(c => ['raw', 'pressed', 'qr_pending'].includes(c.stage)).map(c => ({ cycleId: c._id, pass: cyc(c), stage: c.stage, members: c.cartridgeIds?.length ?? 0, stageEnteredAt: c.stageEnteredAt })));

	const backing = byStatus('backing');
	const backedInPass = backing.filter(c => memberOf.has(c._id));
	const loose = backing.filter(c => !memberOf.has(c._id));
	console.log(`\n  backing (Backed): ${backing.length} total — ${backedInPass.length} in an open pass, ${loose.length} loose ("in oven")`);
	console.log(`    loose by age:    ${ageLine(loose)}`);
	console.log(`    loose by origin: ${hist(loose, c => c.backing?.manualBackedAt ? 'State Change → Backed (no bucket)' : c.bucket?.cycleId ? 'came out of a bucket pass' : c.backing?.lotId ? 'legacy BackingLot' : c.backing?.bucketCycleId ? 'old WI-01 draw' : 'no bucket lineage at all').map(([k, n]) => `${k}: ${n}`).join(' | ')}`);
	findings.backing_loose = loose.map(c => slim(c, { bucketId: c.bucket?.bucketId ?? null, cycleId: c.bucket?.cycleId ?? null, manualBackedAt: c.backing?.manualBackedAt ?? null, legacyLotId: c.backing?.lotId ?? null, waxRunId: c.waxFilling?.runId ?? null }));

	// ---- 3. wax --------------------------------------------------------------
	h1('3. WAX');
	const waxRuns = await db.collection('wax_filling_runs').find({}, { projection: { status: 1, cartridgeIds: 1, createdAt: 1, updatedAt: 1, 'robot.name': 1, deckId: 1, runStartTime: 1, runEndTime: 1 } }).toArray() as any[];
	const waxRunById = new Map(waxRuns.map(r => [String(r._id), r]));
	console.log(`  wax runs by status: ${hist(waxRuns, r => r.status ?? '<null>').map(([k, n]) => `${k} ${n}`).join(', ')}`);
	const waxActive = waxRuns.filter(r => WAX_NON_TERMINAL.includes(r.status));
	const allCartStatus = async (ids: string[]) => new Map((await carts.find({ _id: { $in: ids } as any }, { projection: { status: 1 } }).toArray()).map((c: any) => [c._id, c.status]));
	const waxActiveRows = [];
	for (const r of waxActive) {
		const st = await allCartStatus(r.cartridgeIds ?? []);
		waxActiveRows.push({ runId: r._id, status: r.status, robot: r.robot?.name ?? null, createdAt: r.createdAt, ageDays: ageDays(r.createdAt), carts: r.cartridgeIds?.length ?? 0, cartStatuses: Object.fromEntries(hist([...st.values()], s => String(s))) });
	}
	flag('wax_runs_not_terminal', 'wax runs not in a terminal state (older than a day = abandoned?)', waxActiveRows);
	for (const r of waxActiveRows) console.log(`      ${r.runId}  ${String(r.status).padEnd(16)} ${day(r.createdAt)} (${r.ageDays}d)  robot ${r.robot ?? '—'}  carts ${r.carts}  ${JSON.stringify(r.cartStatuses)}`);

	const waxFilling = byStatus('wax_filling');
	flag('wax_filling_no_live_run', 'cart at wax_filling but its wax run is finished / missing — stuck mid-wax',
		waxFilling.filter(c => { const r = waxRunById.get(String(c.waxFilling?.runId ?? '')); return !r || !WAX_NON_TERMINAL.includes(r.status); })
			.map(c => slim(c, { waxRunId: c.waxFilling?.runId ?? null, runStatus: waxRunById.get(String(c.waxFilling?.runId ?? ''))?.status ?? '(no such run)', waxStorage: c.waxStorage?.location ?? null })));
	const waxFilled = byStatus(['wax_filled', 'wax_ready']);
	flag('wax_filled_no_run', 'cart at wax_filled / wax_ready with no wax run on record (quick-wax-fill / state-change / legacy)',
		waxFilled.filter(c => !c.waxFilling?.runId).map(c => slim(c, { usedForTestFill: !!c.usedForTestFill, waxStorage: c.waxStorage?.location ?? null })));
	flag('wax_filled_run_not_completed', 'cart at wax_filled / wax_ready whose wax run is not completed',
		waxFilled.filter(c => { const r = c.waxFilling?.runId && waxRunById.get(String(c.waxFilling.runId)); return r && !/^completed$/i.test(r.status ?? ''); })
			.map(c => slim(c, { waxRunId: c.waxFilling.runId, runStatus: waxRunById.get(String(c.waxFilling.runId))?.status })));
	flag('wax_filled_no_fridge', 'cart at wax_filled / wax_ready with no fridge location recorded',
		waxFilled.filter(c => !c.waxStorage?.locationId && !c.waxStorage?.location).map(c => slim(c, { waxRunId: c.waxFilling?.runId ?? null })));
	console.log(`    wax_filled/wax_ready by fridge: ${hist(waxFilled, c => c.waxStorage?.location ?? c.waxStorage?.locationId ?? '<none>').map(([k, n]) => `${k}: ${n}`).join(' | ')}`);
	flag('wax_ready_carts', 'carts at wax_ready (nothing in the normal flow writes this any more)', byStatus('wax_ready').map(c => slim(c, { waxRunId: c.waxFilling?.runId ?? null, waxQc: c.waxQc?.status ?? null })));

	// ---- 4. reagent ----------------------------------------------------------
	h1('4. REAGENT');
	const rRuns = await db.collection('reagent_batch_records').find({}, { projection: { status: 1, 'cartridgesFilled.cartridgeId': 1, createdAt: 1, updatedAt: 1, 'robot.name': 1, 'assayType.name': 1 } }).toArray() as any[];
	const rRunById = new Map(rRuns.map(r => [String(r._id), r]));
	console.log(`  reagent runs by status: ${hist(rRuns, r => r.status ?? '<null>').map(([k, n]) => `${k} ${n}`).join(', ')}`);
	const rActiveRows = [];
	for (const r of rRuns.filter(r => REAGENT_NON_TERMINAL.includes(r.status))) {
		const ids = (r.cartridgesFilled ?? []).map((x: any) => x.cartridgeId).filter(Boolean);
		const st = await allCartStatus(ids);
		rActiveRows.push({ runId: r._id, status: r.status, robot: r.robot?.name ?? null, assay: r.assayType?.name ?? null, createdAt: r.createdAt, ageDays: ageDays(r.createdAt), carts: ids.length, cartStatuses: Object.fromEntries(hist([...st.values()], s => String(s))) });
	}
	flag('reagent_runs_not_terminal', 'reagent runs not in a terminal state (older than a day = abandoned?)', rActiveRows);
	for (const r of rActiveRows) console.log(`      ${r.runId}  ${String(r.status).padEnd(12)} ${day(r.createdAt)} (${r.ageDays}d)  robot ${r.robot ?? '—'}  carts ${r.carts}  ${JSON.stringify(r.cartStatuses)}`);
	flag('reagent_filling_no_live_run', 'cart at reagent_filling but its reagent run is finished / missing — stuck mid-fill',
		byStatus('reagent_filling').filter(c => { const r = rRunById.get(String(c.reagentFilling?.runId ?? '')); return !r || !REAGENT_NON_TERMINAL.includes(r.status); })
			.map(c => slim(c, { reagentRunId: c.reagentFilling?.runId ?? null, runStatus: rRunById.get(String(c.reagentFilling?.runId ?? ''))?.status ?? '(no such run)' })));
	const postFill = byStatus(['reagent_filled', 'sealed', 'reagent_qc', 'reagent_ready']);
	flag('reagent_filled_no_run', 'cart at reagent_filled / reagent_qc / reagent_ready with no reagent run on record',
		postFill.filter(c => !c.reagentFilling?.runId).map(c => slim(c, { usedForTestFill: !!c.usedForTestFill })));
	flag('reagent_filled_run_not_completed', 'cart past reagent fill whose reagent run is not completed',
		postFill.filter(c => { const r = c.reagentFilling?.runId && rRunById.get(String(c.reagentFilling.runId)); return r && !/^completed$/i.test(r.status ?? ''); })
			.map(c => slim(c, { reagentRunId: c.reagentFilling.runId, runStatus: rRunById.get(String(c.reagentFilling.runId))?.status })));
	flag('reagent_expired_in_process', 'cart at reagent_filled / reagent_qc / reagent_ready already past its reagent expiration date',
		postFill.filter(c => c.reagentFilling?.expirationDate && new Date(c.reagentFilling.expirationDate).getTime() < now).map(c => slim(c, { expirationDate: c.reagentFilling.expirationDate })));

	// ---- 5. status vs the cart's own record ----------------------------------
	h1('5. STATUS vs THE CART\'S OWN RECORD');
	flag('status_missing_or_unknown', 'cart with no status, or a status that is not in the enum',
		wip.filter(c => c.status == null || !KNOWN_STATUSES.includes(c.status)).map(c => slim(c)));
	flag('status_legacy', 'cart at a retired status (raw / pressed / wax_stored / wax_qc / sealed)', byStatus(LEGACY_STATUSES).map(c => slim(c)));
	flag('prewax_but_wax_recorded', 'status is before wax (bucket stage / backing) but a wax fill is recorded on the cart',
		byStatus(PRE_WAX).filter(c => c.waxFilling?.runEndTime || c.waxFilling?.recordedAt).map(c => slim(c, { waxRunId: c.waxFilling?.runId ?? null, waxRunStatus: waxRunById.get(String(c.waxFilling?.runId ?? ''))?.status ?? null })));
	flag('prereagent_but_reagent_recorded', 'status is before reagent fill but a reagent fill is recorded on the cart',
		byStatus([...PRE_WAX, 'wax_filling', 'wax_filled', 'wax_ready', 'wax_stored', 'wax_qc']).filter(c => c.reagentFilling?.fillDate || c.reagentFilling?.recordedAt)
			.map(c => slim(c, { reagentRunId: c.reagentFilling?.runId ?? null, reagentRunStatus: rRunById.get(String(c.reagentFilling?.runId ?? ''))?.status ?? null, usedForTestFill: !!c.usedForTestFill })));
	flag('inprocess_but_tested', 'in-process status but the cart has a test execution / result or is marked used',
		wip.filter(c => IN_PROCESS.includes(c.status) && (c.used === true || c.testExecution?.executedAt || c.testResult?.status)).map(c => slim(c, { used: c.used ?? null, testResult: c.testResult?.status ?? null, executedAt: c.testExecution?.executedAt ?? null })));
	flag('inprocess_but_voided', 'in-process status but voidedAt is set', wip.filter(c => IN_PROCESS.includes(c.status) && c.voidedAt).map(c => slim(c, { voidedAt: c.voidedAt })));
	flag('inprocess_in_fg_fridge', 'in-process (pre-stored) status but finished-goods storage is recorded on the cart',
		wip.filter(c => IN_PROCESS.includes(c.status) && (c.storage?.fridgeId || c.storage?.recordedAt)).map(c => slim(c, { fridgeId: c.storage?.fridgeId ?? null })));

	// ---- summary -------------------------------------------------------------
	h1('SUMMARY — non-empty findings');
	for (const [k, v] of Object.entries(findings)) {
		if (!Array.isArray(v) || !v.length || ['statusHistogram', 'backing_loose'].includes(k)) continue;
		console.log(`  ${k.padEnd(36)} ${String(v.length).padStart(5)}   e.g. ${sample(v.map((r: any) => String(r._id ?? r.runId ?? r.cycleId ?? r.bucketId)), 4)}`);
	}

	const i = process.argv.indexOf('--json');
	if (i > -1 && process.argv[i + 1]) {
		writeFileSync(process.argv[i + 1], JSON.stringify({ at: new Date().toISOString(), db: db.databaseName, findings }, null, 1));
		console.log(`\nfull detail → ${process.argv[i + 1]}`);
	}
	await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
