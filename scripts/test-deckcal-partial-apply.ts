/**
 * Regression test for the deck-calibration partial-apply bug (2026-07-13, deck-001).
 *
 * A band shift of dy=-2.4 was applied to all 288 reagent wells. The 12 row-A wells sit
 * at y=0.25-0.8mm — on the labware's y=0 floor — so the bounds guard rejected them while
 * the other 276 were written anyway. The operator got "Applied to 276 hole(s) ✓" and the
 * front row was left 2.4mm out of line with its own band. Undo then made it worse: the
 * undo stack held the REQUESTED wells, so the inverse (+2.4, back in bounds) MOVED the 12
 * holes that had never moved.
 *
 * The guard itself is correct and must stay: a well at y<0 makes the whole definition fail
 * registration on the robot. The fix is that the batch is now ALL-OR-NOTHING.
 *
 * Runs against a throwaway labware def, never deck-001. Cleans up after itself.
 *   MONGODB_URI=... npx tsx scripts/test-deckcal-partial-apply.ts
 */
import { connectDB } from '../src/lib/server/db/connection';
import { LabwareDefinition, DeckCalibrationEdit } from '../src/lib/server/db/models';
import { applyDeckEditBatch } from '../src/lib/server/services/deck-calibration/apply-edit';

const LOAD_NAME = '__test_deckcal_guard__';
const USER = { _id: 'test', username: 'test-deckcal-guard' };

const wells = () => ({
	// Front row — right on the y=0 floor, exactly like deck-001's row A.
	A1: { x: 50, y: 0.8, z: 7.8, depth: 5, shape: 'circular', diameter: 3, totalLiquidVolume: 100 },
	A3: { x: 60, y: 0.25, z: 7.8, depth: 5, shape: 'circular', diameter: 3, totalLiquidVolume: 100 },
	// Rows well clear of the edge.
	B1: { x: 50, y: 7.4, z: 7.8, depth: 5, shape: 'circular', diameter: 3, totalLiquidVolume: 100 },
	B3: { x: 60, y: 7.4, z: 7.8, depth: 5, shape: 'circular', diameter: 3, totalLiquidVolume: 100 },
	C1: { x: 50, y: 16.4, z: 7.8, depth: 5, shape: 'circular', diameter: 3, totalLiquidVolume: 100 }
});

const ALL = ['A1', 'A3', 'B1', 'B3', 'C1'];
let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
	console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
	if (!ok) failures++;
};

const coords = async () => {
	const d: any = await LabwareDefinition.findOne({ loadName: LOAD_NAME }).lean();
	return d.definition.wells as Record<string, { x: number; y: number; z: number }>;
};

async function main() {
	await connectDB();
	await LabwareDefinition.deleteOne({ loadName: LOAD_NAME });
	await DeckCalibrationEdit.deleteMany({ deckLoadName: LOAD_NAME });
	await LabwareDefinition.create({
		_id: 'test-deckcal-guard',
		namespace: 'test',
		loadName: LOAD_NAME,
		version: 1,
		displayName: 'deck-cal guard test',
		category: 'Other',
		definition: {
			namespace: 'test',
			version: 1,
			parameters: { loadName: LOAD_NAME },
			metadata: { displayName: 'deck-cal guard test' },
			dimensions: { xDimension: 200, yDimension: 200, zDimension: 12.7 },
			wells: wells()
		}
	});

	console.log('\n1. the exact deck-001 failure: shift the whole band by dy=-2.4');
	console.log('   (A1 y=0.8 and A3 y=0.25 would go negative — off the labware)');
	const before = await coords();
	const r = await applyDeckEditBatch({
		deckLoadName: LOAD_NAME, wellNames: ALL, delta: { x: -1, y: -2.4, z: 0 }, user: USER
	});
	const after = await coords();

	check('the batch is REFUSED (applied = 0)', r.applied === 0, `applied=${r.applied}`);
	check('it names the blocking holes', r.failed.map((f) => f.wellName).sort().join(',') === 'A1,A3',
		r.failed.map((f) => f.wellName).join(',') || 'none');
	check('the reason is the labware edge', /outside the labware/.test(r.failed[0]?.reason ?? ''),
		r.failed[0]?.reason);
	check('NOTHING moved — not even the in-bounds holes (this is the fix)',
		ALL.every((w) => after[w].x === before[w].x && after[w].y === before[w].y),
		`B1 y ${before.B1.y} -> ${after.B1.y}`);
	check('no history rows were written for a refused batch',
		(await DeckCalibrationEdit.countDocuments({ deckLoadName: LOAD_NAME })) === 0);
	console.log('   (old behaviour: B1/B3/C1 would have moved and A1/A3 stayed —');
	console.log('    the front row left 2.4mm out of line with its own band.)');

	console.log('\n2. a shift that clears the edge still applies normally');
	const r2 = await applyDeckEditBatch({
		deckLoadName: LOAD_NAME, wellNames: ALL, delta: { x: 0, y: -0.2, z: 0 }, user: USER
	});
	const a2 = await coords();
	check('all 5 holes applied', r2.applied === 5, `applied=${r2.applied}`);
	check('nothing rejected', r2.failed.length === 0);
	check('A3 moved 0.25 -> 0.05 (still on the labware)', Math.abs(a2.A3.y - 0.05) < 1e-6, `y=${a2.A3.y}`);
	check('history written for all 5', (await DeckCalibrationEdit.countDocuments({ deckLoadName: LOAD_NAME })) === 5);

	console.log('\n3. the batch is atomic in the other direction too (z runaway)');
	const b3 = await coords();
	const r3 = await applyDeckEditBatch({
		deckLoadName: LOAD_NAME, wellNames: ALL, delta: { x: 0, y: 0, z: 500 }, user: USER
	});
	const a3 = await coords();
	check('refused', r3.applied === 0);
	check('no hole moved', ALL.every((w) => a3[w].z === b3[w].z));

	await LabwareDefinition.deleteOne({ loadName: LOAD_NAME });
	await DeckCalibrationEdit.deleteMany({ deckLoadName: LOAD_NAME });
	console.log(`\n${failures ? `${failures} FAILURE(S)` : 'ALL PASS'}  (scratch labware cleaned up)\n`);
	process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
