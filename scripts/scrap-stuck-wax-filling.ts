/**
 * Scrap carts stranded at wax_filling (Jacob, 2026-10-05): a cart at
 * wax_filling is only real if it is on a wax run that is live right now. Any
 * other wax_filling cart — its run aborted / finished / missing — is scrapped.
 * Carts on a live run are never written. Dry-run by default; --apply to write.
 *
 *   npx tsx scripts/scrap-stuck-wax-filling.ts [--apply]
 *
 * Undo: priorStatus on the cart and an audit_log row (action
 * 'wax_filling_stuck_scrap') both carry the old status.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import { nanoid } from 'nanoid';
dotenv.config();

const APPLY = process.argv.includes('--apply');
// wax-filling-run.ts WAX_NON_TERMINAL
const LIVE = ['Setup', 'Loading', 'Running', 'Awaiting Removal', 'QC', 'Storage',
	'setup', 'loading', 'running', 'awaiting_removal', 'cooling', 'qc', 'storage'];
const ACTOR = 'migration:wax-filling-stuck-2026-10-05';
const REASON = 'Stranded at wax_filling: not on a live wax run (2026-10-05 cleanup)';

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	console.log(`db: ${db.databaseName}   ${new Date().toISOString()}   ${APPLY ? '*** APPLY ***' : '(dry run)'}`);
	const carts = db.collection('cartridge_records');

	const liveRuns = await db.collection('wax_filling_runs').find({ status: { $in: LIVE } }, { projection: { status: 1, cartridgeIds: 1, 'robot.name': 1, createdAt: 1 } }).toArray() as any[];
	const liveRunIds = new Set(liveRuns.map(r => String(r._id)));
	const onLiveDeck = new Set<string>(liveRuns.flatMap(r => r.cartridgeIds ?? []));
	for (const r of liveRuns) console.log(`live run ${r._id}  ${r.status}  ${r.robot?.name ?? '—'}  carts ${r.cartridgeIds?.length ?? 0}  started ${r.createdAt?.toISOString().slice(0, 16)}`);

	const all = await carts.find({ status: 'wax_filling' }, { projection: { 'waxFilling.runId': 1, updatedAt: 1 } }).toArray() as any[];
	// Live = the cart's own run is live OR a live run lists it (either link is enough to leave it alone).
	const isLive = (c: any) => liveRunIds.has(String(c.waxFilling?.runId ?? '')) || onLiveDeck.has(c._id);
	const keep = all.filter(isLive);
	const targets = all.filter(c => !isLive(c));
	console.log(`\nwax_filling: ${all.length}   KEEP (on a live run): ${keep.length}   SCRAP (not on a live run): ${targets.length}`);
	const by = new Map<string, number>();
	for (const c of targets) by.set(String(c.waxFilling?.runId ?? 'none'), (by.get(String(c.waxFilling?.runId ?? 'none')) ?? 0) + 1);
	const runs = new Map((await db.collection('wax_filling_runs').find({ _id: { $in: [...by.keys()] } as any }, { projection: { status: 1, createdAt: 1 } }).toArray()).map((r: any) => [String(r._id), r]));
	for (const [k, n] of by) console.log(`  ${String(n).padStart(3)}  run ${k.padEnd(22)} ${runs.get(k)?.status ?? '(no such run)'}  started ${runs.get(k)?.createdAt?.toISOString().slice(0, 10) ?? '—'}`);

	if (!APPLY || !targets.length) { console.log(APPLY ? '\nNothing to scrap.' : '\nDry run only — re-run with --apply to write.'); await mongoose.disconnect(); return; }

	const now = new Date();
	const ids = targets.map(c => c._id);
	// status in the filter: a cart that moved since the read above is left alone.
	const res = await carts.updateMany({ _id: { $in: ids } as any, status: 'wax_filling' }, {
		$set: { status: 'scrapped', priorStatus: 'wax_filling', statusUpdatedOn: now.toISOString(), voidedAt: now, voidReason: REASON, updatedAt: now },
		$push: { notes: { _id: nanoid(), body: `Scrapped: stranded at wax_filling — its wax run was aborted / is not live (2026-10-05 cleanup).`, phase: 'scrap', author: { _id: 'system', username: ACTOR }, createdAt: now } } as any
	});
	const done = await carts.find({ _id: { $in: ids } as any, status: 'scrapped', statusUpdatedOn: now.toISOString() }, { projection: { _id: 1 } }).toArray();
	await db.collection('audit_log').insertMany(done.map((c: any) => ({ _id: nanoid(), tableName: 'cartridge_records', recordId: c._id, action: 'wax_filling_stuck_scrap', oldData: { status: 'wax_filling' }, newData: { status: 'scrapped' }, reason: REASON, changedAt: now, changedBy: ACTOR })));
	console.log(`\nAPPLIED. matched ${res.matchedCount}, scrapped ${res.modifiedCount}, audit rows ${done.length}.  wax_filling now: ${await carts.countDocuments({ status: 'wax_filling' })}`);
	await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
