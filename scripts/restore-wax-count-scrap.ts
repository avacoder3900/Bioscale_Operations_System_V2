/**
 * Undo part of scripts/scrap-wax-not-on-list.ts (2026-10-05 wax physical count).
 *
 * Restores carts that the reconciliation scrapped back to wax_filled, selected
 * by wax run. Written for wax run vbriez9HZz3OyIL-7l_rW: its 12 carts were
 * completed + stored by the operator at 17:07 UTC, after the count was taken,
 * and the 17:11 pass scrapped them because they were not on the (older) list.
 *
 *   npx tsx scripts/restore-wax-count-scrap.ts --wax-run <runId>            # dry run
 *   npx tsx scripts/restore-wax-count-scrap.ts --wax-run <runId> --apply
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import { nanoid } from 'nanoid';
dotenv.config();

const APPLY = process.argv.includes('--apply');
const i = process.argv.indexOf('--wax-run');
const RUN = i > -1 ? process.argv[i + 1] : undefined;
const REASON = 'Not found in the 2026-10-05 physical count of wax-filled cartridges';
const ACTOR = 'migration:wax-physical-count-2026-10-05';

async function main() {
	if (!RUN) throw new Error('--wax-run <runId> is required');
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const carts = db.collection('cartridge_records');
	console.log(`db: ${db.databaseName}   ${new Date().toISOString()}   ${APPLY ? '*** APPLY ***' : '(dry run)'}`);

	// Only carts this reconciliation scrapped (its voidReason), and only from wax_filled.
	const filter = { 'waxFilling.runId': RUN, status: 'scrapped', voidReason: REASON, priorStatus: 'wax_filled' };
	const rows = await carts.find(filter, { projection: { _id: 1, 'waxStorage.location': 1 } }).toArray() as any[];
	console.log(`wax run ${RUN}: ${rows.length} cart(s) scrapped by the count reconciliation`);
	for (const r of rows) console.log(`  ${r._id}  fridge ${r.waxStorage?.location ?? '—'}`);
	if (!APPLY || !rows.length) { console.log(APPLY ? 'Nothing to restore.' : '\nDry run only — re-run with --apply to write.'); await mongoose.disconnect(); return; }

	const now = new Date();
	const res = await carts.updateMany({ _id: { $in: rows.map(r => r._id) } as any, ...filter }, {
		$set: { status: 'wax_filled', statusUpdatedOn: now.toISOString(), updatedAt: now },
		$unset: { voidedAt: '', voidReason: '' },
		$push: { notes: { _id: nanoid(), body: 'Restored to wax_filled: scrapped in error by the 2026-10-05 count reconciliation — this cart was wax-filled and stored after the count was taken.', phase: 'scrap', author: { _id: 'system', username: ACTOR }, createdAt: now } } as any
	});
	await db.collection('audit_log').insertMany(rows.map(r => ({
		_id: nanoid(),
		tableName: 'cartridge_records',
		recordId: r._id,
		action: 'wax_physical_count_scrap_reverted',
		oldData: { status: 'scrapped' },
		newData: { status: 'wax_filled' },
		reason: `Scrapped in error: wax-filled after the physical count was taken (wax run ${RUN})`,
		changedAt: now,
		changedBy: ACTOR
	})));
	console.log(`restored ${res.modifiedCount} cart(s) to wax_filled`);
	const st = await carts.aggregate([{ $match: { status: { $in: ['wax_filling', 'wax_filled', 'wax_ready'] } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]).toArray();
	console.log(st.map((r: any) => `${r._id} ${r.n}`).join(', '));
	await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
