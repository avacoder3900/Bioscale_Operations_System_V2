/**
 * Physical-count reconciliation of the wax stage (Jacob, 2026-10-05).
 *
 * Input: a text file of cartridge ids, one per line — every cart physically
 * counted at wax filled. Every cart at status wax_filled | wax_ready that is
 * NOT on the list is scrapped. Carts on the list are never written, whatever
 * their status. Dry-run by default; --apply to write. Idempotent.
 *
 *   npx tsx scripts/scrap-wax-not-on-list.ts --list <file> [--json <out>]
 *   npx tsx scripts/scrap-wax-not-on-list.ts --list <file> --apply
 *   --hold-wax-run <runId[,runId]>   leave that wax run's carts alone (reported, not scrapped)
 *   --as-of <ISO time>               REQUIRED with --apply: when the count was taken. A cart whose
 *                                    record changed after it is never scrapped — it reached the wax
 *                                    stage after the count, so the list cannot speak for it.
 *
 * Undo: every scrapped cart gets an audit_log row (action
 * 'wax_physical_count_scrap') carrying its old status, and priorStatus on the
 * cart itself holds the same value.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
dotenv.config();

const APPLY = process.argv.includes('--apply');
const arg = (name: string) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : undefined; };
const LIST = arg('--list');
const JSON_OUT = arg('--json');
const AS_OF = arg('--as-of') ? new Date(arg('--as-of')!) : null;
const HOLD_RUNS = (arg('--hold-wax-run') ?? '').split(',').map(s => s.trim()).filter(Boolean);
const WAX_STATUSES = ['wax_filled', 'wax_ready'];
const ACTOR = 'migration:wax-physical-count-2026-10-05';
const REASON = 'Not found in the 2026-10-05 physical count of wax-filled cartridges';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DAY = 86_400_000;

const hist = <T,>(rows: T[], key: (r: T) => string) => {
	const m = new Map<string, number>();
	for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + 1);
	return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}: ${n}`).join(' | ');
};
const age = (d: unknown) => {
	if (!d) return 'no date';
	const a = Math.floor((Date.now() - new Date(d as any).getTime()) / DAY);
	return a <= 7 ? '0-7d' : a <= 14 ? '8-14d' : a <= 30 ? '15-30d' : a <= 60 ? '31-60d' : '60d+';
};

async function main() {
	if (!LIST) throw new Error('--list <file> is required');
	const raw = readFileSync(LIST, 'utf8');
	const lines = raw.split(/\r?\n/).map(l => l.trim().toLowerCase()).filter(Boolean);
	const list = new Set(lines);
	const dups = [...new Set(lines.filter((l, i) => lines.indexOf(l) !== i))];
	const malformed = [...list].filter(l => !UUID.test(l));
	console.log(`list: ${lines.length} lines, ${list.size} unique, ${dups.length} duplicated id(s), ${malformed.length} malformed   sha256 ${createHash('sha256').update([...list].sort().join('\n')).digest('hex').slice(0, 16)}`);
	if (dups.length) console.log(`  duplicated: ${dups.join(', ')}`);
	if (malformed.length) console.log(`  malformed: ${malformed.join(', ')}`);

	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	console.log(`db: ${db.databaseName} @ ${mongoose.connection.host}   ${new Date().toISOString()}   ${APPLY ? '*** APPLY ***' : '(dry run)'}`);
	const carts = db.collection('cartridge_records');
	const proj = { status: 1, priorStatus: 1, updatedAt: 1, used: 1, usedForTestFill: 1, 'waxFilling.runId': 1, 'waxStorage.location': 1, 'waxStorage.locationId': 1, 'reagentFilling.runId': 1 };

	// ---- the list itself ----
	const onList = await carts.find({ _id: { $in: [...list] } as any }, { projection: proj }).toArray() as any[];
	const found = new Set(onList.map(c => c._id));
	const notFound = [...list].filter(id => !found.has(id));
	console.log(`\nLIST vs DB`);
	console.log(`  on the list and in the DB: ${onList.length}   on the list but NO cartridge record: ${notFound.length}`);
	if (notFound.length) console.log(`    no record: ${notFound.join(', ')}`);
	console.log(`  list carts by current status: ${hist(onList, c => String(c.status))}`);
	const listNotWax = onList.filter(c => !WAX_STATUSES.includes(c.status));
	for (const c of listNotWax) console.log(`    on the list but not at wax_filled/wax_ready: ${c._id}  status=${c.status}  prior=${c.priorStatus ?? '—'}  updated ${c.updatedAt?.toISOString?.().slice(0, 10) ?? '—'}`);

	// ---- what gets scrapped ----
	const offList = await carts.find({ status: { $in: WAX_STATUSES }, _id: { $nin: [...list] } as any }, { projection: proj }).toArray() as any[];
	const held = offList.filter(c => HOLD_RUNS.includes(String(c.waxFilling?.runId ?? '')));
	const afterCount = offList.filter(c => AS_OF && c.updatedAt && new Date(c.updatedAt).getTime() > AS_OF.getTime());
	const targets = offList.filter(c => !held.includes(c) && !afterCount.includes(c));
	const keep = onList.filter(c => WAX_STATUSES.includes(c.status));
	const removals = await db.collection('manual_cartridge_removals').find({}, { projection: { cartridgeIds: 1 } }).toArray() as any[];
	const checkedOut = new Set<string>(removals.flatMap(r => r.cartridgeIds ?? []));
	const liveReagent = await db.collection('reagent_batch_records').find({ status: { $in: ['Setup', 'Loading', 'Running', 'setup', 'loading', 'running'] } }, { projection: { 'cartridgesFilled.cartridgeId': 1 } }).toArray() as any[];
	const onLiveRun = new Set<string>(liveReagent.flatMap(r => (r.cartridgesFilled ?? []).map((x: any) => x.cartridgeId)));

	console.log(`\nWAX STAGE (wax_filled + wax_ready): ${offList.length + keep.length}`);
	if (HOLD_RUNS.length) console.log(`  HOLD  (not on the list, wax run ${HOLD_RUNS.join(', ')} — left alone): ${held.length}`);
	if (afterCount.length) console.log(`  SKIP  (not on the list, but changed after the count at ${AS_OF!.toISOString()} — left alone): ${afterCount.length}   wax runs: ${hist(afterCount, c => String(c.waxFilling?.runId ?? 'none'))}`);
	console.log(`  KEEP  (on the list):     ${keep.length}   ${hist(keep, c => c.status)}`);
	console.log(`  SCRAP (not on the list): ${targets.length}   ${hist(targets, c => c.status)}`);
	console.log(`    by last update:        ${hist(targets, c => age(c.updatedAt))}`);
	console.log(`    by last-update month:  ${hist(targets, c => c.updatedAt?.toISOString?.().slice(0, 7) ?? 'none')}`);
	console.log(`    fridge on record:      ${hist(targets, c => c.waxStorage?.location ?? c.waxStorage?.locationId ?? '<none>')}`);
	console.log(`    test-fill carts: ${targets.filter(c => c.usedForTestFill).length}   used:true: ${targets.filter(c => c.used === true).length}   no wax run: ${targets.filter(c => !c.waxFilling?.runId).length}   already checked out: ${targets.filter(c => checkedOut.has(c._id)).length}   on a live reagent run: ${targets.filter(c => onLiveRun.has(c._id)).length}`);
	console.log(`  kept carts by last update: ${hist(keep, c => age(c.updatedAt))}`);

	if (JSON_OUT) {
		writeFileSync(JSON_OUT, JSON.stringify({ at: new Date().toISOString(), applied: APPLY, list: [...list], notFound, listNotWax, targets, held, keep: keep.map(c => c._id) }, null, 1));
		console.log(`\nmanifest → ${JSON_OUT}`);
	}

	if (!APPLY) { console.log('\nDry run only — re-run with --apply to write.'); await mongoose.disconnect(); return; }
	if (!AS_OF || isNaN(AS_OF.getTime())) throw new Error('Refusing to apply without --as-of <ISO time the count was taken>.');
	if (notFound.length || malformed.length) throw new Error('Refusing to apply: the list has ids with no cartridge record / malformed ids. Resolve them first.');
	if (targets.some(c => onLiveRun.has(c._id))) throw new Error('Refusing to apply: a target cart is on a live reagent run.');

	const now = new Date();
	let scrapped = 0;
	for (const from of WAX_STATUSES) {
		const ids = targets.filter(c => c.status === from).map(c => c._id);
		if (!ids.length) continue;
		// Status in the filter: a cart that moved since the read above is left alone.
		const res = await carts.updateMany(
			{ _id: { $in: ids } as any, status: from },
			{
				$set: { status: 'scrapped', priorStatus: from, statusUpdatedOn: now.toISOString(), voidedAt: now, voidReason: REASON, updatedAt: now },
				$push: { notes: { _id: nanoid(), body: `Scrapped: ${REASON.charAt(0).toLowerCase()}${REASON.slice(1)} (was ${from}).`, phase: 'scrap', author: { _id: 'system', username: ACTOR }, createdAt: now } } as any
			}
		);
		const done = await carts.find({ _id: { $in: ids } as any, status: 'scrapped', statusUpdatedOn: now.toISOString() }, { projection: { _id: 1 } }).toArray();
		await db.collection('audit_log').insertMany(done.map((c: any) => ({
			_id: nanoid(),
			tableName: 'cartridge_records',
			recordId: c._id,
			action: 'wax_physical_count_scrap',
			oldData: { status: from },
			newData: { status: 'scrapped' },
			reason: REASON,
			changedAt: now,
			changedBy: ACTOR
		})));
		console.log(`  ${from} → scrapped: matched ${res.matchedCount}, modified ${res.modifiedCount}, audit rows ${done.length}`);
		scrapped += res.modifiedCount;
	}
	const after = await carts.aggregate([{ $match: { status: { $in: [...WAX_STATUSES, 'scrapped'] } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]).toArray();
	console.log(`\nAPPLIED. ${scrapped} cart(s) scrapped. Now: ${after.map((r: any) => `${r._id} ${r.n}`).join(', ')}`);
	await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
