/**
 * Set Location = "R&D" on every active (non-retired) SPU that has no location.
 *
 * Why: the research app's push-assay / devices fleet is now keyed on
 * `spus.location` matching R&D (it used to key on the retired
 * assignment.type='research' flag). Jacob wants the whole active fleet in it
 * so the optical-confirmation assay can be pushed to all 31 units (2026-09-10).
 *
 * Units that already carry a location are left alone. Retired units are left
 * alone. Every write gets an audit_log row.
 *
 *   npx tsx scripts/set-spu-location-rnd.ts            # dry run
 *   npx tsx scripts/set-spu-location-rnd.ts --apply    # write
 */
import mongoose from 'mongoose';
import { nanoid } from 'nanoid';
import * as dotenv from 'dotenv';
dotenv.config();

const APPLY = process.argv.includes('--apply');
const LOCATION = 'R&D';

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const spus = db.collection('spus');

	const targets = await spus
		.find({ status: { $ne: 'retired' }, $or: [{ location: { $exists: false } }, { location: null }, { location: '' }] })
		.project({ udi: 1, status: 1, location: 1 })
		.sort({ udi: 1 })
		.toArray();

	const already = await spus.countDocuments({ status: { $ne: 'retired' }, location: { $regex: /^\s*r\s*(?:&|and|n)\s*d\s*$/i } });

	console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — ${targets.length} active SPU(s) without a location; ${already} already R&D`);
	for (const t of targets) console.log(`  ${t.udi}  (${t.status})`);
	if (!APPLY || targets.length === 0) {
		if (!APPLY) console.log('Re-run with --apply to write.');
		await mongoose.disconnect();
		return;
	}

	const now = new Date();
	for (const t of targets) {
		await spus.updateOne({ _id: t._id }, { $set: { location: LOCATION } });
		await db.collection('audit_log').insertOne({
			_id: nanoid(),
			tableName: 'spus',
			recordId: t._id,
			action: 'UPDATE',
			oldData: { location: t.location ?? null },
			newData: { location: LOCATION },
			changedBy: 'script:set-spu-location-rnd (jacob)',
			changedAt: now,
			reason: 'Bulk: active fleet joins the R&D location so the research app can push assays to it'
		});
	}
	console.log(`Wrote location="${LOCATION}" on ${targets.length} SPU(s) with audit rows.`);
	await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
