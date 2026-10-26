/**
 * CALIB-5 migration (2026-10-26): undo the day's shared-definition rack edits
 * where a robot's own offset is the right home for them, so no robot moves from
 * the geometry it is working with right now.
 *
 *   A. cosmas_and_damian_drybath_tuberack (wax, slot 10): the shared definition
 *      goes back to the 2026-10-14 geometry every robot completed wax runs on
 *      (B07 at 15:06Z today). Today's 19:22Z −3/0/+2 edit (B07 selected) never
 *      completed a run; it is kept as a NOTE on B07's offset row (vector 0).
 *   B. cosmasanddamian_96_tiprack_20ul (wax, slot 11): the shared definition
 *      STAYS as it is now (Oct-14 geometry +1 Y; B07 picked up and probed
 *      first-time on it at 19:36Z). R04 gets the offset that reproduces the
 *      position it worked on today (Oct-14 +2/+5): current A1 → that point.
 *   C. The 200 µL rack and custom_2ml_24 rack are left alone (every robot ran
 *      on the current geometry).
 *
 * Same raw-mongoose pattern as scripts/shift-deck-wells.ts (the service layer is
 * not importable outside SvelteKit). Every well is guarded against the expected
 * value; any mismatch aborts before writing. Plan is the default.
 *
 * NOTE: the offsets only take effect once each robot runs a protocol that
 * declares the CALIB-5 RTPs (Sync both protocols after deploying the .py). The
 * drybath revert reaches each robot at its next run start (auto-resync).
 *
 *   MONGODB_URI=... npx tsx scripts/migrate-rack-offsets.ts          # plan
 *   MONGODB_URI=... npx tsx scripts/migrate-rack-offsets.ts --apply  # write
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
import { generateId } from '../src/lib/server/db/utils.js';

const MODE: 'plan' | 'apply' = process.argv.includes('--apply') ? 'apply' : 'plan';
const OPERATOR = 'claude-code';
const ROBOT = { B07: '2vIu0fzsbqzkZ7_Zjj3h2', R04: 'CCyX8FjTRGvYOd9vISGvi', B14: '8LufEAi5sYJ5JRk_fTfT7' } as const;
const DRYBATH = 'cosmas_and_damian_drybath_tuberack';
const TIP20 = 'cosmasanddamian_96_tiprack_20ul';

/** Geometry bundled in B07's 2026-10-14 wax upload (b02c03b4), i.e. what all three ran on. */
const OCT14_DRYBATH: Record<string, [number, number, number]> = {
	A1: [36.5, 73, 67.25], B1: [36.5, 57, 67.25], C1: [36.5, 41, 67.25],
	A2: [50.5, 73, 67.25], B2: [50.5, 57, 67.25], C2: [50.5, 41, 67.25],
	A3: [64.5, 73, 67.25], B3: [64.5, 57, 67.25], C3: [64.5, 41, 67.25],
	A4: [78.5, 73, 67.25], B4: [78.5, 57, 67.25], C4: [78.5, 41, 67.25],
	A5: [92.5, 73, 67.25], B5: [92.5, 57, 67.25], C5: [92.5, 41, 67.25]
};
/** Today's 19:22Z shared edit, the one being moved off the shared definition. */
const DRYBATH_EDIT = { x: -3, y: 0, z: 2 };
/** Oct-14 A1 of the 20 µL rack; R04's working position today was this +2/+5. */
const OCT14_TIP20_A1 = { x: 14.38, y: 74.74, z: 21.62 };
const R04_WORKING_A1 = { x: OCT14_TIP20_A1.x + 2, y: OCT14_TIP20_A1.y + 5, z: OCT14_TIP20_A1.z };
const LIMIT = 10;

const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
const r3 = (v: number) => +v.toFixed(3);

async function main() {
	const uri = process.env.MONGODB_URI;
	if (!uri) { console.error('MONGODB_URI is not set.'); process.exit(1); }
	await mongoose.connect(uri);
	const db = mongoose.connection.db!;
	console.log(`[${MODE}] db=${db.databaseName}`);
	const now = new Date();
	const problems: string[] = [];
	const writes: Array<() => Promise<void>> = [];

	// ── A. drybath shared revert ────────────────────────────────────────────────
	const drybathDocs = await db.collection('labware_definitions').find({ loadName: DRYBATH }).toArray();
	if (drybathDocs.length !== 1) { console.error(`Expected 1 definition for ${DRYBATH}, found ${drybathDocs.length}`); process.exit(1); }
	const drybath = drybathDocs[0] as any;
	const drybathUri = `${drybath.namespace}/${DRYBATH}/${drybath.version}`;
	const dw = drybath.definition?.wells ?? {};
	const setOps: Record<string, number> = {};
	const history: any[] = [];
	let drybathAlreadyBaseline = true;
	for (const [w, [x, y, z]] of Object.entries(OCT14_DRYBATH)) {
		const cur = dw[w];
		if (!cur) { problems.push(`${DRYBATH} ${w}: missing`); continue; }
		const atBaseline = near(cur.x, x) && near(cur.y, y) && near(cur.z, z);
		const atEdited = near(cur.x, x + DRYBATH_EDIT.x) && near(cur.y, y + DRYBATH_EDIT.y) && near(cur.z, z + DRYBATH_EDIT.z);
		if (!atBaseline) drybathAlreadyBaseline = false;
		if (!atBaseline && !atEdited) { problems.push(`${DRYBATH} ${w}: current (${cur.x},${cur.y},${cur.z}) is neither Oct-14 nor Oct-14${JSON.stringify(DRYBATH_EDIT)}`); continue; }
		if (atEdited) {
			setOps[`definition.wells.${w}.x`] = x; setOps[`definition.wells.${w}.y`] = y; setOps[`definition.wells.${w}.z`] = z;
			history.push({ _id: generateId(), deckLoadName: DRYBATH, deckEquipmentId: null, wellName: w, delta: { x: -DRYBATH_EDIT.x, y: -DRYBATH_EDIT.y, z: -DRYBATH_EDIT.z }, before: { x: cur.x, y: cur.y, z: cur.z }, after: { x, y, z }, robotId: null, createdBy: OPERATOR, createdAt: now });
		}
	}
	console.log(`A. ${DRYBATH} (${drybathUri}): ${drybathAlreadyBaseline ? 'already at Oct-14 geometry — nothing to revert' : `${history.length} wells go back to Oct-14 (A1 → ${OCT14_DRYBATH.A1.join(', ')})`}`);
	if (history.length) {
		writes.push(async () => {
			await db.collection('labware_definitions').updateOne({ _id: drybath._id }, { $set: { ...setOps, hasUnpublishedEdits: true } });
			await db.collection('deck_calibration_edits').insertMany(history);
			await db.collection('audit_log').insertOne({ _id: generateId(), tableName: 'labware_definitions', recordId: DRYBATH, action: 'deck_calibration_edit_batch', newData: { delta: { x: -DRYBATH_EDIT.x, y: -DRYBATH_EDIT.y, z: -DRYBATH_EDIT.z }, wellCount: history.length, wells: history.map((h) => h.wellName), robotId: null, note: 'CALIB-5 migration: shared drybath rack back to the 2026-10-14 geometry; the 19:22Z -3/0/+2 edit (B07 selected) is noted on B07\'s per-robot offset row.' }, changedAt: now, changedBy: OPERATOR } as any);
		});
	}

	// ── B. R04 offset on the 20 µL rack ─────────────────────────────────────────
	const tipDocs = await db.collection('labware_definitions').find({ loadName: TIP20 }).toArray();
	if (tipDocs.length !== 1) { console.error(`Expected 1 definition for ${TIP20}, found ${tipDocs.length}`); process.exit(1); }
	const tip = tipDocs[0] as any;
	const tipUri = `${tip.namespace}/${TIP20}/${tip.version}`;
	const a1 = tip.definition?.wells?.A1 ?? {};
	const r04Vec = { x: r3(R04_WORKING_A1.x - a1.x), y: r3(R04_WORKING_A1.y - a1.y), z: r3(R04_WORKING_A1.z - a1.z) };
	console.log(`B. ${TIP20} (${tipUri}) shared A1 stays (${a1.x}, ${a1.y}, ${a1.z}); R04 offset = R04 working A1 (${R04_WORKING_A1.x}, ${R04_WORKING_A1.y}) − shared = (${r04Vec.x}, ${r04Vec.y}, ${r04Vec.z})`);
	for (const k of ['x', 'y', 'z'] as const) if (!Number.isFinite(r04Vec[k]) || Math.abs(r04Vec[k]) > LIMIT) problems.push(`R04 20 µL offset ${k}=${r04Vec[k]} is outside ±${LIMIT}`);

	const upsertOffset = async (robotId: string, loadName: string, definitionUri: string, slotName: string, vector: { x: number; y: number; z: number }, note: string) => {
		const sel = { robotId, definitionUri, slotName };
		const prev = await db.collection('robot_labware_offsets').findOne(sel);
		const before = prev?.vector ?? { x: 0, y: 0, z: 0 };
		const update: any = { $set: { loadName, vector, taughtBy: { username: OPERATOR }, taughtAt: now, source: 'migration', note }, $setOnInsert: { _id: generateId(), history: [] } };
		if (prev) update.$push = { history: { $each: [{ vector: before, taughtBy: prev.taughtBy ?? null, taughtAt: prev.taughtAt ?? null, source: prev.source ?? 'studio', note: prev.note ?? null }], $position: 0, $slice: 10 } };
		if (prev) delete update.$setOnInsert.history;
		await db.collection('robot_labware_offsets').updateOne(sel, update, { upsert: true });
		await db.collection('audit_log').insertOne({ _id: generateId(), tableName: 'robot_labware_offsets', recordId: `${robotId}:${slotName}:${loadName}`, action: 'save_rack_offset', newData: { robotId, loadName, definitionUri, slotName, before, after: vector, delta: null, source: 'migration', note }, changedAt: now, changedBy: OPERATOR } as any);
	};
	writes.push(() => upsertOffset(ROBOT.R04, TIP20, tipUri, '11', r04Vec, 'CALIB-5 migration: reproduces the Oct-14 +2/+5 rack position R04 picked up first-time on (run 5119b591, 2026-10-26 16:16Z) relative to the shared definition as of 2026-10-26.'));
	writes.push(() => upsertOffset(ROBOT.B07, DRYBATH, drybathUri, '10', { x: 0, y: 0, z: 0 }, 'CALIB-5 migration: the 2026-10-26 19:22Z Studio edit -3/0/+2 (B07 selected) was moved off the shared definition; it never completed a run, so B07 starts at 0. Re-teach in the Studio if B07 needs it.'));
	console.log(`C. B07 ${DRYBATH} offset row: vector 0 with the 19:22Z note. 200 µL rack and custom_2ml_24 rack: untouched.`);

	if (problems.length) { console.error(`\nABORT — ${problems.length} problem(s):`); for (const p of problems) console.error('  ' + p); await mongoose.disconnect(); process.exit(1); }
	if (MODE === 'plan') { console.log(`\nplan only: ${writes.length} write group(s). Re-run with --apply.`); await mongoose.disconnect(); return; }
	for (const w of writes) await w();
	const check = await db.collection('robot_labware_offsets').find({ robotId: { $in: [ROBOT.R04, ROBOT.B07] } }).toArray();
	console.log('\nAPPLIED. robot_labware_offsets now:'); for (const c of check) console.log(`  ${c.robotId} ${c.slotName} ${c.loadName} ${JSON.stringify(c.vector)}`);
	const d2 = (await db.collection('labware_definitions').findOne({ _id: drybath._id })) as any;
	console.log(`  ${DRYBATH} A1 = (${d2.definition.wells.A1.x}, ${d2.definition.wells.A1.y}, ${d2.definition.wells.A1.z})`);
	console.log('\nNEXT: deploy the CALIB-5 protocols (Sync wax + reagent to all robots); the drybath revert reaches each robot at its next run start.');
	await mongoose.disconnect();
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
