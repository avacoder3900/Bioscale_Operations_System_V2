/**
 * Deck Z preflight — is this labware definition actually flyable?
 *
 * READ-ONLY. Never writes. Answers, for one deck def + one tip, the question
 * the robot otherwise answers for you by crashing: how tall can this deck be,
 * and does its current geometry fit under the gantry?
 *
 * Motivation (docs/DECK-Z-HEIGHT-APPROACH.md): the Z guards in this codebase
 * were written for a 12.7mm deck. Above ~35mm the arc stops rising with the deck,
 * so both guards are now bounded by the MACHINE, not by the deck:
 *
 *   - the Studio refuses to move once safeArcZ leaves under MIN_ARC_CLEARANCE_MM
 *     over the deck (it still caps at ARC_CEILING_MM — the gantry is real — but a
 *     cap that has eaten the clearance is a rejection, not a smaller arc).
 *   - apply-edit's well zMax is min(zDimension + 40, ARC_CEILING - MIN_ARC_CLEARANCE),
 *     so a raised deck can no longer certify a well above the gantry ceiling.
 *
 * This script shows what those guards will do before a robot is involved, and is
 * the only place that reports the TIP-specific ceiling — the guards assume a
 * Biotix tip, so a longer tip lowers the real ceiling below what they enforce.
 *
 * Usage:
 *   npx tsx scripts/deck-z-preflight.ts --file docs/deck001-live-labware-def-2026-08-19.json
 *   MONGODB_URI=... npx tsx scripts/deck-z-preflight.ts --deck gen4deck_gen7cartridge_001
 *   ... --tip p20 --target-height 70
 *
 * Flags:
 *   --file <path>        read the def from a local JSON (no DB)
 *   --deck <loadName>    read the def from labware_definitions (needs MONGODB_URI)
 *   --tip <name|mm>      biotix | p20 | vwr20 | p1000 | <number>   (default biotix)
 *   --target-height <mm> a proposed STRUCTURE height to test (deck top above slot)
 *   --gantry <mm>        override the gantry Z limit (default 170, UNVERIFIED)
 */
import * as dotenv from 'dotenv';
import { readFileSync } from 'fs';
dotenv.config();

const argv = process.argv.slice(2);
const arg = (n: string): string | null => {
	const i = argv.indexOf('--' + n);
	return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
};

/**
 * Effective tip extension = tipLength - tipOverlap: how far the tip hangs below
 * the nozzle, which is what actually consumes gantry travel. Measured from
 * backups/calibration-golden-2026-07-29-all-robots-confirmed.json, not estimated.
 */
const TIPS: Record<string, { label: string; length: number; overlap: number; mountable: boolean }> = {
	biotix: { label: 'biotix_96_200ul/300ul_tiprack (p300)', length: 59.47, overlap: 7.47, mountable: true },
	p20: { label: 'cosmasanddamian_96_tiprack_20ul (p20)', length: 45.66, overlap: 0, mountable: true },
	vwr20: { label: 'vwradapater_96_tiprack_20ul (p20)', length: 45.56, overlap: 0, mountable: true },
	p1000: { label: 'custom_96_tiprack_1250ul (P1000 - NOT on these robots)', length: 102, overlap: 0, mountable: false }
};

// Mirrors of the live constants. If these drift from source, this script lies.
const ARC_CLEARANCE_MM = 80; // deck-calibration/+page.svelte
const ARC_CEILING_MM = 115; // deck-calibration/+page.svelte
const Z_UPPER_MARGIN_MM = 40; // services/deck-calibration/apply-edit.ts
const MIN_ARC_CLEARANCE_MM = 10; // both, via MAX_FLYABLE_WELL_Z_MM / assertArcFlyable
const MAX_FLYABLE_WELL_Z_MM = ARC_CEILING_MM - MIN_ARC_CLEARANCE_MM;

const MIN_TRAVEL_CLEARANCE_MM = 10; // absolute floor for "the tip cleared it"
const SANE_TRAVEL_CLEARANCE_MM = 25; // what you actually want to design to

const GANTRY_Z_LIMIT_MM = Number(arg('gantry') ?? 170);
const GANTRY_VERIFIED = arg('gantry') !== null;

const f = (n: number, w = 8) => n.toFixed(2).padStart(w);
const line = (label: string, val: string, note = '') =>
	console.log(`  ${label.padEnd(38)}${val}${note ? '  ' + note : ''}`);

async function loadDef(): Promise<{ def: any; source: string; loadName: string }> {
	const file = arg('file');
	if (file) {
		const raw = JSON.parse(readFileSync(file, 'utf8'));
		const def = raw.definition ?? raw;
		return { def, source: `file ${file}`, loadName: def?.parameters?.loadName ?? '(unnamed)' };
	}
	const deck = arg('deck');
	if (!deck) throw new Error('Need --file <path> or --deck <loadName>');
	if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI missing (required for --deck)');
	const mongoose = (await import('mongoose')).default;
	await mongoose.connect(process.env.MONGODB_URI);
	const doc: any = await mongoose.connection
		.db!.collection('labware_definitions')
		.findOne({ loadName: deck }, { sort: { version: -1 } });
	await mongoose.disconnect();
	if (!doc) throw new Error(`No labware_definitions row with loadName '${deck}'`);
	return {
		def: doc.definition,
		source: `mongo ${doc.namespace}/${doc.loadName}/v${doc.version}`,
		loadName: doc.loadName
	};
}

async function main() {
	const { def, source, loadName } = await loadDef();

	const tipKey = (arg('tip') ?? 'biotix').toLowerCase();
	const numericTip = Number(tipKey);
	const tip =
		Number.isFinite(numericTip) && numericTip > 0
			? { label: `explicit ${numericTip}mm`, length: numericTip, overlap: 0, mountable: true }
			: TIPS[tipKey];
	if (!tip) throw new Error(`Unknown --tip '${tipKey}'. Use: ${Object.keys(TIPS).join(' | ')} | <mm>`);
	const tipEff = tip.length - tip.overlap;

	const zDim = Number(def?.dimensions?.zDimension ?? 0);
	const wells: [string, any][] = Object.entries(def?.wells ?? {});
	const wellTops = wells.map(([n, w]) => ({
		n,
		top: Number(w.z ?? 0) + Number(w.depth ?? 0),
		z: Number(w.z ?? 0),
		depth: Number(w.depth ?? 0)
	}));
	const maxTop = wellTops.length ? Math.max(...wellTops.map((w) => w.top)) : 0;

	const criticalCeiling = GANTRY_Z_LIMIT_MM - tipEff;
	const effectiveCeiling = Math.min(criticalCeiling, ARC_CEILING_MM);
	const rawArc = Math.round(zDim + ARC_CLEARANCE_MM);
	const safeArcZ = Math.min(rawArc, ARC_CEILING_MM);
	const clamped = rawArc > ARC_CEILING_MM;
	// Mirrors dimsOf(): deck-relative margin OR the machine bound, whichever binds.
	const editZMax = Math.min(zDim + Z_UPPER_MARGIN_MM, MAX_FLYABLE_WELL_Z_MM);
	const arcClearance = safeArcZ - zDim;

	const maxStructAbs = effectiveCeiling - MIN_TRAVEL_CLEARANCE_MM;
	const maxStructSane = effectiveCeiling - SANE_TRAVEL_CLEARANCE_MM;

	console.log(`\nDECK Z PREFLIGHT - ${loadName}`);
	console.log(`source: ${source}\n`);

	console.log('GEOMETRY');
	line('zDimension (declared deck height)', f(zDim) + ' mm');
	line('max(well.z + depth)', f(maxTop) + ' mm');
	line('wells', String(wells.length).padStart(8));

	console.log('\nTIP');
	line('rack', tip.label.padStart(8));
	line('tipLength - tipOverlap', `${f(tip.length)} - ${tip.overlap.toFixed(2)}`);
	line('= effective extension', f(tipEff) + ' mm', tip.mountable ? '' : 'WARN: NOT MOUNTABLE on p20/p300');

	console.log('\nCEILINGS');
	line(
		'gantry Z limit',
		f(GANTRY_Z_LIMIT_MM) + ' mm',
		GANTRY_VERIFIED ? '(override)' : 'WARN: UNVERIFIED - measure by homing'
	);
	line('- effective tip', f(tipEff) + ' mm');
	line('= critical-point ceiling', f(criticalCeiling) + ' mm');
	line('ARC_CEILING_MM (code-enforced)', f(ARC_CEILING_MM) + ' mm');
	line(
		'-> binding ceiling',
		f(effectiveCeiling) + ' mm',
		criticalCeiling < ARC_CEILING_MM
			? 'WARN: GANTRY binds before the code cap'
			: '(code cap binds first - conservative)'
	);

	console.log('\nARC');
	line(
		'safeArcZ = min(zDim + 80, 115)',
		f(safeArcZ) + ' mm',
		clamped ? `WARN: CLAMPED (raw ${rawArc}) - no longer tracks the deck` : ''
	);
	line(
		'clearance over highest well',
		f(safeArcZ - maxTop) + ' mm',
		safeArcZ - maxTop < MIN_TRAVEL_CLEARANCE_MM ? 'FAIL: ARC AT/BELOW THE DECK - crash path' : ''
	);
	line(
		'clearance over declared deck',
		f(arcClearance) + ' mm',
		arcClearance < MIN_ARC_CLEARANCE_MM
			? `BLOCKED: Studio refuses to move (< ${MIN_ARC_CLEARANCE_MM}mm)`
			: clamped
				? 'note: arc is capped, clearance shrinks as the deck rises'
				: ''
	);

	console.log('\nEDIT GUARD (apply-edit.ts)');
	line(
		'well zMax = min(zDim + 40, 105)',
		f(editZMax) + ' mm',
		editZMax < zDim + Z_UPPER_MARGIN_MM ? 'machine bound binds' : 'deck bound binds'
	);
	line('deck height max (dimension edit)', f(MAX_FLYABLE_WELL_Z_MM) + ' mm');
	if (editZMax > effectiveCeiling) {
		line(
			'',
			'',
			`WARN: guard accepts up to ${editZMax.toFixed(2)}mm, ${(editZMax - effectiveCeiling).toFixed(2)}mm ABOVE the real ceiling`
		);
		console.log('     -> the edit guard can certify an UNFLYABLE well at this zDimension.');
	}

	console.log('\nMAX STRUCTURE HEIGHT (deck top above the slot surface)');
	line(`absolute (ceiling - ${MIN_TRAVEL_CLEARANCE_MM}mm)`, f(maxStructAbs) + ' mm', 'WARN: no design margin');
	line(`recommended (ceiling - ${SANE_TRAVEL_CLEARANCE_MM}mm)`, f(maxStructSane) + ' mm', '<- design to this');

	// --- violations -------------------------------------------------------
	console.log('\nVIOLATIONS');
	let bad = 0;
	const overDim = wellTops.filter((w) => w.top > zDim + 1e-6);
	if (overDim.length) {
		bad += overDim.length;
		console.log(`  FAIL: ${overDim.length} well(s) break z + depth <= zDimension (hole pokes out the top):`);
		for (const w of overDim.slice(0, 10))
			console.log(`       ${w.n.padEnd(6)} z ${f(w.z, 7)} + depth ${f(w.depth, 6)} = ${f(w.top, 7)} > ${zDim}`);
		if (overDim.length > 10) console.log(`       ... and ${overDim.length - 10} more`);
	}
	const overCeil = wellTops.filter((w) => w.top > effectiveCeiling);
	if (overCeil.length) {
		bad += overCeil.length;
		console.log(`  FAIL: ${overCeil.length} well(s) sit above the flyable ceiling ${effectiveCeiling}mm`);
	}
	if (safeArcZ <= maxTop) {
		bad++;
		console.log(
			`  FAIL: safeArcZ ${safeArcZ} <= highest well ${maxTop.toFixed(2)} - the "safe" arc flies INTO the deck`
		);
	}
	if (!bad) {
		console.log('  OK: all wells satisfy z + depth <= zDimension');
		console.log('  OK: no well above the flyable ceiling');
		console.log('  OK: arc clears the highest well');
	}

	// --- target-height verdict -------------------------------------------
	const target = arg('target-height');
	if (target !== null) {
		const H = Number(target);
		console.log(`\nTARGET STRUCTURE HEIGHT: ${H} mm`);
		const tArc = Math.min(Math.round(H + ARC_CLEARANCE_MM), ARC_CEILING_MM);
		const tClear = tArc - H;
		line('implied safeArcZ', f(tArc) + ' mm', H + ARC_CLEARANCE_MM > ARC_CEILING_MM ? 'WARN: clamped' : '');
		line('clearance over the structure', f(tClear) + ' mm');
		line('binding ceiling', f(effectiveCeiling) + ' mm');
		line('headroom (ceiling - H)', f(effectiveCeiling - H) + ' mm');
		const tEdit = Math.min(H + Z_UPPER_MARGIN_MM, MAX_FLYABLE_WELL_Z_MM);
		line(
			'edit guard would accept up to',
			f(tEdit) + ' mm',
			tEdit > effectiveCeiling ? `WARN: ${(tEdit - effectiveCeiling).toFixed(2)}mm above THIS tip\x27s ceiling` : ''
		);
		line(
			'dimension edit would',
			H > MAX_FLYABLE_WELL_Z_MM ? 'REJECT' : 'accept',
			H > MAX_FLYABLE_WELL_Z_MM ? `> ${MAX_FLYABLE_WELL_Z_MM}mm flyable max` : ''
		);
		console.log('');
		if (H >= effectiveCeiling)
			console.log(`  NO-GO: ${H}mm is at/above the ${effectiveCeiling}mm ceiling. The tip cannot clear it.`);
		else if (tClear < MIN_TRAVEL_CLEARANCE_MM) console.log(`  NO-GO: only ${tClear.toFixed(2)}mm of arc clearance.`);
		else if (tClear < SANE_TRAVEL_CLEARANCE_MM)
			console.log(`  MARGINAL: ${tClear.toFixed(2)}mm clearance. Flyable, but no design margin.`);
		else
			console.log(`  GO: ${tClear.toFixed(2)}mm arc clearance, ${(effectiveCeiling - H).toFixed(2)}mm under the ceiling.`);
		if (!GANTRY_VERIFIED)
			console.log(`     (assumes gantry Z limit ${GANTRY_Z_LIMIT_MM}mm - UNVERIFIED. Measure it by homing.)`);
	}
	console.log('');
}

main().catch((e) => {
	console.error('\n' + (e instanceof Error ? e.message : String(e)) + '\n');
	process.exit(1);
});
