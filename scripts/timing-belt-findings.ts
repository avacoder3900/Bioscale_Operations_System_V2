/**
 * Timing Belt Investigation — record Jacob's bench notes (2026-09-15).
 *
 * Group: "Timing Belt Investigation on all SPUs" (service_groups, opened 2026-09-02).
 * For every unit on Jacob's sheet:
 *   - if the unit has no ServiceRecord in the group:
 *       · an OPEN job with no group and no reason of its own (a bare scan-in)
 *         JOINS the group (groupId set) — same as the board's enroll path;
 *       · an OPEN job with its own reason (a different problem) is left in
 *         place and the belt finding is recorded on it with a
 *         "[Timing Belt Investigation]" prefix, so nothing is mislabelled;
 *       · otherwise a record is CREATED directly — NOT via the board's enroll
 *         path, which would flip a released unit to `servicing` and reset its
 *         validation cycle (one open job per unit is enforced by a unique
 *         index). previousStatus = the unit's CURRENT status, so a later close
 *         returns it unchanged. SPU status is never touched here.
 *   - one finding is pushed with the note verbatim (prefixed by the code Jacob
 *     wrote beside the unit). Outcome: 'ok' when the sheet says "no notes",
 *     'issue' otherwise — no attempt to grade severity; Jacob re-grades on the board.
 *   - an audit row per record.
 * One group-level note records where the findings came from.
 * Units already in the group but not on the sheet are left untouched.
 *
 *   npx tsx scripts/timing-belt-findings.ts            # dry run
 *   npx tsx scripts/timing-belt-findings.ts --apply
 */
import mongoose from 'mongoose';
import { nanoid } from 'nanoid';
import * as dotenv from 'dotenv';
dotenv.config();

const APPLY = process.argv.includes('--apply');

// [unit, code as written, note as written]
const SHEET: Array<[string, string, string]> = [
	['0246', '713b0', 'no grub screws, 3d printed proximal, timing belt length 348, stripped back enclosure screws, needed new channel A & B mag'],
	['0222', '71254', 'timing belt length 349, 3d printed proximal, no heat shield on top upper magnet bracket'],
	['0211', '71A08', 'no notes'],
	['0214', '71F50', 'no notes'],
	['0244', '71d98', 'timing belt length 348, back screws stripped'],
	['0215', '7138c', '3d printed proximal, extra long cartridge heater, timing belt 348 length, resistor removed from stepper circuit needed to swap the board, longer cartridge heater'],
	['0226', '71AD8', 'wrong proximal, timing belt 348, dirty filter, no heat shielding, shielding not sticking, something wrong with stage board (handwriting unclear), small pulley'],
	['0253', '71220', 'board swapped, bridged solder, linear rail stuck, dirty filter, timing belt length (value not recorded)'],
	['0210', '719D4', 'timing belt length 351, row 1 not passing mag, but ultimately passed'],
	['0248', '71A30', '3d printed proximal, antenna overlap, badly aligned sensors'],
	['0257', '71b24', 'no notes'],
	['0230', '????', 'no notes'],
	['0203', '71a4c', '3d printed proximal, timing belt length 350, missing torx screw, antennas perpendicular'],
	['0237', '71DC0', 'weird noise during mag'],
	['0223', '71B88', 'timing belt too short'],
	['0247', '515f8', 'no notes'],
	['0202', '7194c', 'timing belt too short'],
	['0251', '71B80', 'timing belt 351, gap on sensors, 3d printed proximal'],
	['0221', '713AC', 'timing belt length 351, heater block swap, upper magnet bracket with no heat shield'],
	['0243', '7135C', '3d printed proximal, did not heat up'],
	['0218', '71DBC', 'timing belt length 350'],
	['0212', '520B4', 'timing belt length 346'],
	['0217', '????', 'oiled rail, timing belt length 351, messed up distal bracket screw'],
	['0249', '71b00', 'no notes'],
	['0245', '7117c', 'channel A not aligned, timing belt length 349'],
	['0256', '71b18', 'failing magnetometer on 9_10_26, timing belt 352, tight stage'],
	['0236', '713B8', 'timing belt length 248 (as written — probably 348)'],
	['0229', '51f34', 'no notes'],
	['0252', '71AFC', 'swapped heater block, new magnets, timing belt length 351, lowered pulley, GNSS antenna overlapping with cellular, wifi antenna on the wrong side, new proximal, temp reading incorrect and light remains red in heat up stage, going really slow when optical reads are taken'],
	['0239', '71A58', '20 tooth pulley, timing belt 349, grindy rail, wrong heater block, wifi antenna in wrong place, no beeper on a failed test'],
	['0255', '71634', 'no screw attached to the heat block from one end, pulley was not leveled properly, timing belt length is 350, one screw missing from top of the main board'],
	['0250', '71a94', 'antenna overlap, thermistor pinched under stage screw, trash stage board, tight stage needs oil, heat shield very ugly, missing foot, 3d printed proximal, specs very misaligned, soldered limit switch, pulley lowered, missing bottom heat shield']
];

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const groups = db.collection('service_groups');
	const records = db.collection('service_records');
	const spus = db.collection('spus');
	const audit = db.collection('audit_log');

	const jacob: any = await db.collection('users').findOne({ username: 'jacob' }, { projection: { _id: 1, username: 1 } });
	if (!jacob) throw new Error('user jacob not found');
	const who = { _id: String(jacob._id), username: jacob.username };
	const group: any = await groups.findOne({ name: /timing belt/i, status: 'open' });
	if (!group) throw new Error('Timing Belt group not found / not open');

	const now = new Date();
	console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — group "${group.name}" (${group._id}), ${SHEET.length} units on the sheet\n`);

	let created = 0, findings = 0;
	for (const [unit, code, note] of SHEET) {
		const udi = `BT-M01-0000-${unit}`;
		const spu: any = await spus.findOne({ udi }, { projection: { _id: 1, udi: 1, status: 1, barcode: 1, 'assignment.customer.name': 1, finalizedAt: 1 } });
		if (!spu) { console.log(`${unit}  NOT FOUND — skipped`); continue; }
		if (spu.finalizedAt) { console.log(`${unit}  finalized — skipped`); continue; }

		let rec: any = await records.findOne({ groupId: group._id, spuId: spu._id });
		let how = rec ? (rec.status === 'open' ? 'in group' : `in group (${rec.status})`) : 'ADD to group';
		let prefix = `[${code}]`;
		let joinExisting: any = null;
		if (!rec) {
			// One open job per unit (unique index): reuse an existing open job.
			const openElsewhere: any = await records.findOne({ spuId: spu._id, status: 'open' });
			if (openElsewhere && openElsewhere.groupId && openElsewhere.groupId !== group._id) {
				console.log(`${unit}  ${String(spu.status).padEnd(10)}  open job in ANOTHER group — skipped`);
				continue;
			}
			if (openElsewhere && !openElsewhere.groupId) {
				if (!(openElsewhere.reason ?? '').trim()) {
					joinExisting = openElsewhere; // bare scan-in → joins the group
					how = 'JOIN existing open job to group';
				} else {
					rec = openElsewhere; // different problem → finding recorded there, group untouched
					prefix = `[Timing Belt Investigation] [${code}]`;
					how = `finding on its own open job ("${openElsewhere.reason}")`;
				}
			}
		}
		const outcome = /^no notes$/i.test(note.trim()) ? 'ok' : 'issue';
		const target = rec ?? joinExisting;
		const already = target?.findings?.some((f: any) => typeof f.text === 'string' && f.text.includes(`[${code}]`));
		console.log(`${unit}  ${String(spu.status).padEnd(10)}  ${how}  → ${already ? 'finding already recorded' : `finding (${outcome})`}`);
		if (!APPLY || already) continue;

		if (joinExisting) {
			await records.updateOne({ _id: joinExisting._id }, { $set: { groupId: group._id, updatedAt: now } });
			await audit.insertOne({
				_id: nanoid(), tableName: 'service_records', recordId: joinExisting._id, action: 'UPDATE',
				newData: { groupId: group._id }, changedBy: who.username, changedAt: now,
				reason: 'Timing Belt Investigation — existing open job joined to the group (bench sheet 2026-09-15)'
			});
			rec = joinExisting;
		}

		if (!rec) {
			rec = {
				_id: nanoid(),
				spuId: spu._id,
				spuUdi: spu.udi,
				spuBarcode: spu.barcode ?? undefined,
				customerName: spu.assignment?.customer?.name ?? undefined,
				serviceType: group.serviceType ?? 'inspection',
				priority: group.priority ?? 'normal',
				status: 'open',
				location: '',
				locationHistory: [],
				reason: group.name,
				groupId: group._id,
				findings: [],
				notes: [],
				partsReplaced: [],
				firmwareChanges: [],
				otherChanges: [],
				// The unit keeps whatever status it has now; closing this job later
				// returns it to exactly that.
				previousStatus: spu.status,
				openedAt: now,
				openedBy: who,
				createdAt: now,
				updatedAt: now
			};
			await records.insertOne(rec);
			await audit.insertOne({
				_id: nanoid(), tableName: 'service_records', recordId: rec._id, action: 'INSERT',
				newData: { spuId: spu._id, groupId: group._id, serviceType: rec.serviceType, note: 'Added to group from the bench sheet; SPU status deliberately unchanged' },
				changedBy: who.username, changedAt: now, reason: 'Timing Belt Investigation — unit added to group (bench sheet 2026-09-15)'
			});
			created += 1;
		}

		const text = `${prefix} ${note}`;
		await records.updateOne(
			{ _id: rec._id },
			{ $push: { findings: { _id: nanoid(), text, outcome, addedAt: now, addedBy: who } }, $set: { updatedAt: now } }
		);
		await audit.insertOne({
			_id: nanoid(), tableName: 'service_records', recordId: rec._id, action: 'UPDATE',
			newData: { finding: text, outcome }, changedBy: who.username, changedAt: now,
			reason: `Finding recorded (${outcome}) — Timing Belt Investigation bench sheet`
		});
		findings += 1;
	}

	if (APPLY) {
		await groups.updateOne(
			{ _id: group._id },
			{ $push: { notes: { _id: nanoid(), text: `Bench-sheet findings for ${SHEET.length} units recorded 2026-09-15 (inspection performed 2026-09-02 → 09-10). Outcome 'ok' = "no notes" on the sheet; every other unit is 'issue' pending Jacob's re-grade. Units added to the group today kept their current lifecycle status.`, addedAt: now, addedBy: who } }, $set: { updatedAt: now } }
		);
	}
	console.log(`\n${APPLY ? `Added ${created} unit(s) to the group, recorded ${findings} finding(s), 1 group note.` : 'Re-run with --apply to write.'}`);
	await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
