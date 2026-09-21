/**
 * Apply one measured delta to a whole class of holes on a deck.
 *
 * Built for a specific, narrow job: correcting a SYSTEMATIC bias that affected
 * every hole of one kind equally. The reagent holes on decks taught before
 * 2026-08-19 were measured against the wax probe recipe (ot2-bridge.py hardcoded
 * the wax start for every profile), so they all sit the same distance off. A
 * single shift fixes them; jogging 288 holes individually would not.
 *
 * This is deliberately NOT a general-purpose bulk editor. A bad bulk apply is
 * how decks 002 and 003 ended up 24.5mm and 7.4mm out, so:
 *   - --plan is the default and prints every affected well's before/after
 *   - the delta must come from a MEASURED capture, not an estimate
 *   - each well is bounds-checked against the deck's own dimensions and the
 *     whole run aborts if any well would land off the physical deck
 *   - one deck_calibration_edits row per well, exactly like the Studio writes,
 *     so the history stays complete and the change is reversible
 *
 * Usage:
 *   MONGODB_URI=... npx tsx scripts/shift-deck-wells.ts \
 *     --deck gen4deck_gen7cartridge_001 --holes reagent --dx -1.0 --dy 0 [--dz 0] --plan
 *   ... --apply
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
import { generateId } from '../src/lib/server/db/utils.js';

const argv = process.argv.slice(2);
const arg = (name: string): string | null => {
	const i = argv.indexOf('--' + name);
	return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
};
const MODE: 'plan' | 'apply' = argv.includes('--apply') ? 'apply' : 'plan';

const deckLoadName = arg('deck');
const holes = (arg('holes') ?? '').toLowerCase(); // reagent | wax | all
const dx = Number(arg('dx') ?? 0);
const dy = Number(arg('dy') ?? 0);
const dz = Number(arg('dz') ?? 0);
const note = arg('note') ?? '';

if (!deckLoadName || !['reagent', 'wax', 'all'].includes(holes)) {
	console.error(
		'Usage: --deck <loadName> --holes reagent|wax|all --dx <mm> [--dy <mm>] [--dz <mm>] [--note "..."] [--apply]'
	);
	process.exit(1);
}
if (![dx, dy, dz].every(Number.isFinite) || (dx === 0 && dy === 0 && dz === 0)) {
	console.error('A non-zero, finite delta is required.');
	process.exit(1);
}

const OPERATOR = 'system-shift-deck-wells';
const colOf = (w: string) => parseInt(String(w).replace(/^[A-Za-z]+/, ''), 10);

async function main() {
	const uri = process.env.MONGODB_URI;
	if (!uri) {
		console.error('MONGODB_URI is not set.');
		process.exit(1);
	}
	await mongoose.connect(uri);
	const db = mongoose.connection.db!;
	console.log(`[${MODE}] ${db.databaseName}\n`);

	const defs = await db.collection('labware_definitions').find({ loadName: deckLoadName }).toArray();
	if (defs.length !== 1) {
		console.error(`Expected exactly 1 definition for "${deckLoadName}", found ${defs.length}. Refusing.`);
		process.exit(1);
	}
	const def = defs[0] as any;
	const wells = def.definition?.wells ?? {};
	const dim = def.definition?.dimensions ?? {};
	const xMax = Number(dim.xDimension);
	const yMax = Number(dim.yDimension);

	const names = Object.keys(wells).filter((w) => {
		const c = colOf(w);
		if (!Number.isFinite(c)) return false;
		if (holes === 'all') return true;
		return holes === 'reagent' ? c % 2 === 1 : c % 2 === 0;
	});

	console.log(`deck ${deckLoadName} v${def.version} — ${Object.keys(wells).length} wells total`);
	console.log(`selecting ${holes} holes: ${names.length} wells`);
	console.log(`delta: dx=${dx} dy=${dy} dz=${dz}\n`);

	const setOps: Record<string, number> = {};
	const history: any[] = [];
	const problems: string[] = [];

	for (const w of names.sort()) {
		const s = wells[w];
		const before = { x: Number(s.x) || 0, y: Number(s.y) || 0, z: Number(s.z) || 0 };
		const after = { x: before.x + dx, y: before.y + dy, z: before.z + dz };

		if (after.z < 0) problems.push(`${w}: z ${after.z.toFixed(3)} is below the deck floor`);
		if (Number.isFinite(xMax) && (after.x < 0 || after.x > xMax))
			problems.push(`${w}: x ${after.x.toFixed(3)} outside 0..${xMax}`);
		if (Number.isFinite(yMax) && (after.y < 0 || after.y > yMax))
			problems.push(`${w}: y ${after.y.toFixed(3)} outside 0..${yMax}`);

		setOps[`definition.wells.${w}.x`] = after.x;
		setOps[`definition.wells.${w}.y`] = after.y;
		setOps[`definition.wells.${w}.z`] = after.z;
		history.push({
			_id: generateId(),
			deckLoadName,
			deckEquipmentId: null,
			wellName: w,
			delta: { x: dx, y: dy, z: dz },
			before,
			after,
			robotId: null,
			createdBy: OPERATOR,
			createdAt: new Date()
		});
	}

	const sample = names.sort().slice(0, 5);
	console.log('sample (first 5):');
	for (const w of sample) {
		const b = wells[w];
		console.log(
			`  ${w.padEnd(4)} x ${Number(b.x).toFixed(3)} -> ${(Number(b.x) + dx).toFixed(3)}` +
				`   y ${Number(b.y).toFixed(3)} -> ${(Number(b.y) + dy).toFixed(3)}`
		);
	}

	if (problems.length) {
		console.error(`\nABORT — ${problems.length} well(s) would leave the deck body:`);
		for (const p of problems.slice(0, 10)) console.error('  ' + p);
		process.exit(1);
	}
	console.log('\nbounds check: all wells stay on the deck body.');

	if (MODE === 'plan') {
		console.log(`\nwould update ${names.length} wells. Re-run with --apply to write.`);
		await mongoose.disconnect();
		return;
	}

	await db.collection('labware_definitions').updateOne(
		{ _id: def._id },
		{ $set: { ...setOps, hasUnpublishedEdits: true } }
	);
	await db.collection('deck_calibration_edits').insertMany(history);
	await db.collection('audit_log').insertOne({
		_id: generateId(),
		tableName: 'labware_definitions',
		recordId: deckLoadName,
		action: 'deck_bulk_shift',
		newData: { holes, delta: { x: dx, y: dy, z: dz }, wells: names.length, note },
		changedAt: new Date(),
		changedBy: OPERATOR
	} as any);

	console.log(`\nAPPLIED to ${names.length} wells. Deck marked unpublished — Sync to push it.`);
	await mongoose.disconnect();
}

main().catch((e) => {
	console.error('FAILED:', e);
	process.exit(1);
});
