/**
 * Close every open job in the "Timing Belt Investigation on all SPUs" group by
 * calling the servicing board's REAL `closeService` action (2026-09-15).
 *
 * Why the real action: Jacob reports the Close button "doesn't work" and the
 * database has never seen a closed service job. Driving the action itself from
 * here (a) closes the jobs with exactly the side effects the button would
 * produce — record closed, audit row, SPU journal entry, group auto-closes when
 * drained — and (b) surfaces the action's own failure result if there is one.
 *
 * Lifecycle rule for this run: every unit keeps its CURRENT status (22 were
 * released last week while the jobs stayed open; 0236 sits at servicing for a
 * separate reason). A group close records the inspection; it does not move units.
 *
 *   npx tsx scripts/close-timing-belt-group.ts            # dry run
 *   npx tsx scripts/close-timing-belt-group.ts --apply
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
import { actions } from '../src/routes/spu/mfg/servicing/+page.server.js';

const APPLY = process.argv.includes('--apply');
const RESOLUTION_SHEET = 'Timing belt inspection complete — findings recorded from the bench sheet (2026-09-15).';
const RESOLUTION_NONE = 'Closed with the group task — unit not on the bench sheet, no inspection recorded.';

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const user: any = await db.collection('users').findOne({ username: 'jacob' });
	if (!user) throw new Error('user jacob not found');
	const group: any = await db.collection('service_groups').findOne({ name: /timing belt/i, status: 'open' });
	if (!group) throw new Error('Timing Belt group not found / not open');

	const open = await db.collection('service_records').find({ groupId: group._id, status: 'open' }).sort({ spuUdi: 1 }).toArray();
	console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — ${open.length} open job(s) in "${group.name}"\n`);

	let closed = 0, failed = 0;
	for (const rec of open) {
		const spu: any = await db.collection('spus').findOne({ _id: rec.spuId }, { projection: { udi: 1, status: 1 } });
		const status = spu?.status ?? '?';
		// Pure close: every unit keeps the status it has right now (0236 is at
		// servicing for a reason of its own — a group close must not decide it).
		const returnTo = status;
		const hasFinding = (rec.findings ?? []).length > 0;
		const resolution = hasFinding ? RESOLUTION_SHEET : RESOLUTION_NONE;
		console.log(`${rec.spuUdi.slice(-4)}  ${String(status).padEnd(10)} → return to ${returnTo}  (${hasFinding ? 'findings on record' : 'no findings'})`);
		if (!APPLY) continue;

		const form = new FormData();
		form.set('recordId', rec._id);
		form.set('resolution', resolution);
		form.set('returnToStatus', returnTo);
		const event: any = {
			locals: { user: { ...user, _id: String(user._id) } },
			request: new Request('http://localhost/spu/mfg/servicing?/closeService', { method: 'POST', body: form }),
			url: new URL('http://localhost/spu/mfg/servicing'),
			getClientAddress: () => '127.0.0.1'
		};
		try {
			const result: any = await (actions as any).closeService(event);
			if (result && typeof result === 'object' && 'status' in result && result.status >= 400) {
				failed += 1;
				console.log(`    FAIL ${result.status}: ${JSON.stringify(result.data)}`);
			} else {
				closed += 1;
				console.log(`    closed: ${JSON.stringify(result)}`);
			}
		} catch (err) {
			failed += 1;
			console.log(`    THREW: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
		}
	}
	if (APPLY) {
		const g: any = await db.collection('service_groups').findOne({ _id: group._id }, { projection: { status: 1, resolution: 1 } });
		console.log(`\nClosed ${closed}, failed ${failed}. Group status now: ${g?.status} (${g?.resolution ?? '—'})`);
	} else {
		console.log('\nRe-run with --apply to close through the real action.');
	}
	await mongoose.disconnect();
	process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
