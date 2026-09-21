/**
 * verify-robotarm-deck.ts — independent validator for the Robot Arm Deck artifact.
 *
 * Second opinion on labware/robotarm_cartridge_deck_001.json. Reads only; never
 * writes, never touches Mongo, never calls an API. Exits non-zero on any failure
 * (including "artifact not generated").
 *
 *   npx tsx scripts/verify-robotarm-deck.ts
 *
 * Every geometric expectation is DERIVED FROM THE SOURCE BACKUP at run time, not
 * hardcoded, so this script cannot "agree" with the generator by sharing its
 * assumptions. The only hardcoded values are the identity strings the user chose
 * (namespace/loadName/version/displayName/displayCategory), which have no source.
 */
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const SOURCE_PATH = resolve(
	ROOT,
	'backups/labware-defs-backup-2026-07-28-pre-waxwell-restore.json'
);
/** Defaults to the real artifact; an optional positional arg allows dry-running a candidate file. */
const ARTIFACT_PATH = process.argv[2]
	? resolve(process.cwd(), process.argv[2])
	: resolve(ROOT, 'labware/robotarm_cartridge_deck_001.json');
const SOURCE_LOADNAME = 'gen4deck_gen7cartridge_001';

/** Identity chosen by the user — the one thing with no source of truth to derive from. */
const EXPECT_IDENTITY = {
	namespace: 'cosmas_damian',
	loadName: 'robotarm_cartridge_deck_001',
	version: 1,
	displayName: 'Robot Arm Deck 1 Cartridge Gen7 v1 001',
	displayCategory: 'wellPlate',
	schemaVersion: 2
} as const;

/** Cartridge 1 = rows A,B,C x columns 1..8. */
const ROWS = ['A', 'B', 'C'] as const;
const COLS = [1, 2, 3, 4, 5, 6, 7, 8] as const;
const CART1: string[] = ROWS.flatMap((r) => COLS.map((c) => `${r}${c}`));

/** The studio only lists decks whose loadName matches this (deck-calibration/+page.server.ts). */
const DECK_RE = /(gen4deck|cartridge_deck)/i;

type Well = {
	x: number;
	y: number;
	z: number;
	shape?: string;
	diameter?: number;
	depth?: number;
	totalLiquidVolume?: number;
};
type Definition = {
	namespace?: string;
	version?: number;
	schemaVersion?: number;
	metadata?: { displayName?: string; displayCategory?: string };
	parameters?: { loadName?: string };
	dimensions?: Record<string, number>;
	cornerOffsetFromSlot?: Record<string, number>;
	wells?: Record<string, Well>;
	ordering?: string[][];
	groups?: { wells?: string[] }[];
};

// ── reporting ────────────────────────────────────────────────────────────────
let failures = 0;
let skipped = 0;
const detail: string[] = [];

function pass(n: string, msg: string): void {
	console.log(`  PASS  ${n} — ${msg}`);
}
function fail(n: string, msg: string, lines: string[] = []): void {
	failures++;
	console.log(`  FAIL  ${n} — ${msg}`);
	for (const l of lines.slice(0, 40)) console.log(`          ${l}`);
	if (lines.length > 40) console.log(`          … and ${lines.length - 40} more`);
	detail.push(`${n}: ${msg}`);
}
function skip(n: string, msg: string): void {
	skipped++;
	console.log(`  SKIP  ${n} — ${msg}`);
}
function check(n: string, ok: boolean, okMsg: string, badMsg: string, lines: string[] = []): void {
	ok ? pass(n, okMsg) : fail(n, badMsg, lines);
}

function die(msg: string): never {
	console.error(`\nVERIFY ABORTED: ${msg}\n`);
	process.exit(1);
}

/** Exact numeric identity: rejects NaN, tolerates nothing, and keeps -0 !== 0 honest. */
function sameNumber(a: unknown, b: unknown): boolean {
	return typeof a === 'number' && typeof b === 'number' && Object.is(a, b);
}

// ── load source ──────────────────────────────────────────────────────────────
if (!existsSync(SOURCE_PATH)) die(`source backup not found at ${SOURCE_PATH}`);

let sourceRows: { loadName?: string; definition?: Definition }[];
try {
	sourceRows = JSON.parse(readFileSync(SOURCE_PATH, 'utf8'));
} catch (e) {
	die(`source backup is not valid JSON: ${(e as Error).message}`);
}
if (!Array.isArray(sourceRows)) die('source backup is not a JSON array');

const sourceRow = sourceRows.find((r) => r?.loadName === SOURCE_LOADNAME);
if (!sourceRow?.definition?.wells) {
	die(`source row "${SOURCE_LOADNAME}" (with definition.wells) not found in backup`);
}
const src = sourceRow.definition;
const srcWells = src.wells as Record<string, Well>;

for (const name of CART1) {
	if (!srcWells[name]) die(`source is missing cartridge-1 well ${name}; cannot validate against it`);
}

// ── load artifact ────────────────────────────────────────────────────────────
if (!existsSync(ARTIFACT_PATH)) {
	console.error('\n=== Robot Arm Deck verification ===');
	console.error(`\nartifact not generated — expected ${ARTIFACT_PATH}`);
	console.error('Run the generator (scripts/generate-robotarm-deck.ts) first, then re-run this.\n');
	process.exit(1);
}

let raw: unknown;
try {
	raw = JSON.parse(readFileSync(ARTIFACT_PATH, 'utf8'));
} catch (e) {
	die(`artifact is not valid JSON: ${(e as Error).message}`);
}

/**
 * The upload endpoint (POST /api/opentrons-lab/labware) reads namespace,
 * parameters.loadName and version off the TOP LEVEL of the uploaded file, so the
 * artifact should be a bare Opentrons definition. Accept a Mongo-row wrapper too,
 * but say so loudly — it would not upload correctly.
 */
let def: Definition;
let wrapped = false;
const top = raw as Record<string, unknown> & Definition;
if (top && typeof top === 'object' && !top.wells && top.definition && typeof top.definition === 'object') {
	def = top.definition as Definition;
	wrapped = true;
} else {
	def = top;
}
if (!def || typeof def !== 'object') die('artifact does not parse to an object');

console.log('=== Robot Arm Deck verification ===');
console.log(`source   ${SOURCE_PATH}`);
console.log(`artifact ${ARTIFACT_PATH}`);
console.log('');

// ── 1. shape / uploadability ─────────────────────────────────────────────────
console.log('[1] File shape');
check(
	'1a',
	!wrapped,
	'artifact is a bare Opentrons definition (what the upload endpoint expects)',
	'artifact is wrapped in a Mongo-row envelope ({namespace, definition, …}); POST /api/opentrons-lab/labware reads parameters.loadName off the TOP level and would reject/misfile this'
);
check(
	'1b',
	sameNumber(def.schemaVersion, EXPECT_IDENTITY.schemaVersion),
	`schemaVersion === ${EXPECT_IDENTITY.schemaVersion}`,
	`schemaVersion expected ${EXPECT_IDENTITY.schemaVersion}, got ${JSON.stringify(def.schemaVersion)}`
);
for (const key of ['ordering', 'metadata', 'dimensions', 'wells', 'groups', 'parameters'] as const) {
	check('1c', def[key] !== undefined, `has "${key}"`, `missing required top-level key "${key}"`);
}

// ── 2. identity ──────────────────────────────────────────────────────────────
console.log('\n[2] Identity');
const idChecks: [string, unknown, unknown][] = [
	['namespace', def.namespace, EXPECT_IDENTITY.namespace],
	['version', def.version, EXPECT_IDENTITY.version],
	['parameters.loadName', def.parameters?.loadName, EXPECT_IDENTITY.loadName],
	['metadata.displayName', def.metadata?.displayName, EXPECT_IDENTITY.displayName],
	['metadata.displayCategory', def.metadata?.displayCategory, EXPECT_IDENTITY.displayCategory]
];
for (const [label, actual, expected] of idChecks) {
	check(
		'2',
		actual === expected,
		`${label} = ${JSON.stringify(actual)}`,
		`${label} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
	);
}
check(
	'2f',
	def.parameters?.loadName !== src.parameters?.loadName,
	'loadName differs from the source deck (no collision on upsert key)',
	`loadName collides with the source deck ${JSON.stringify(src.parameters?.loadName)} — upload would OVERWRITE it`
);
check(
	'2g',
	typeof def.parameters?.loadName === 'string' && DECK_RE.test(def.parameters.loadName),
	`loadName matches the studio's DECK_RE ${DECK_RE} — deck will appear in the calibration picker`,
	`loadName ${JSON.stringify(def.parameters?.loadName)} does NOT match DECK_RE ${DECK_RE} — the deck-calibration studio would never list it`
);

// ── 3. footprint preserved (derived from source) ─────────────────────────────
console.log('\n[3] Footprint identical to source (drops into OT-2 slot 1)');
for (const [label, a, b] of [
	['dimensions', def.dimensions, src.dimensions],
	['cornerOffsetFromSlot', def.cornerOffsetFromSlot, src.cornerOffsetFromSlot]
] as const) {
	const keys = Object.keys((b ?? {}) as Record<string, number>);
	const bad = keys.filter(
		(k) => !sameNumber((a as Record<string, number>)?.[k], (b as Record<string, number>)[k])
	);
	const extra = Object.keys((a ?? {}) as Record<string, number>).filter((k) => !keys.includes(k));
	check(
		'3',
		bad.length === 0 && extra.length === 0,
		`${label} exactly matches source (${keys.map((k) => `${k}=${(b as Record<string, number>)[k]}`).join(', ')})`,
		`${label} differs from source`,
		[
			...bad.map(
				(k) =>
					`${label}.${k}: expected ${JSON.stringify((b as Record<string, number>)[k])}, actual ${JSON.stringify((a as Record<string, number>)?.[k])}`
			),
			...extra.map((k) => `${label}.${k}: unexpected extra key`)
		]
	);
}

// ── 4. well roster: exactly the 24 cartridge-1 wells ─────────────────────────
console.log('\n[4] Well roster');
const wells = (def.wells ?? {}) as Record<string, Well>;
const got = Object.keys(wells);
const expectedSet = new Set(CART1);
const missing = CART1.filter((n) => !(n in wells));
const extras = got.filter((n) => !expectedSet.has(n));
check(
	'4a',
	got.length === 24,
	'well count is exactly 24',
	`well count expected 24, got ${got.length}`
);
check('4b', missing.length === 0, 'all 24 expected wells present', 'wells missing', missing.map((n) => `missing well ${n}`));
check(
	'4c',
	extras.length === 0,
	'no extra wells (nothing from cartridges 2..24 leaked in)',
	'extra wells present',
	extras.map((n) => {
		const inSrc = srcWells[n] ? ' (exists in source — belongs to another cartridge)' : '';
		return `unexpected well ${n}${inSrc}`;
	})
);

// ── 5. coordinates EXACTLY equal to source (===, no epsilon) ─────────────────
console.log('\n[5] Coordinates exactly equal to source (===)');
const coordBad: string[] = [];
for (const name of CART1) {
	const w = wells[name];
	const s = srcWells[name];
	if (!w) continue; // already reported in [4]
	for (const axis of ['x', 'y', 'z'] as const) {
		if (!sameNumber(w[axis], s[axis])) {
			coordBad.push(
				`${name}.${axis}: expected ${JSON.stringify(s[axis])}, actual ${JSON.stringify(w[axis])}`
			);
		}
	}
}
check(
	'5',
	coordBad.length === 0,
	'all 24 wells have x/y/z byte-identical to the source definition',
	`${coordBad.length} coordinate mismatch(es)`,
	coordBad
);

// ── 6. per-well invariants ───────────────────────────────────────────────────
console.log('\n[6] Per-well invariants');
const NOMINAL = { shape: 'circular', diameter: 1.8, depth: 3.75, totalLiquidVolume: 18 } as const;
const invBad: string[] = [];
const srcDriftNote: string[] = [];
for (const name of CART1) {
	const w = wells[name];
	const s = srcWells[name];
	if (!w) continue;
	// primary: must equal the source well's own values (exact)
	for (const k of ['shape', 'diameter', 'depth', 'totalLiquidVolume'] as const) {
		const same = k === 'shape' ? w[k] === s[k] : sameNumber(w[k], s[k]);
		if (!same) {
			invBad.push(`${name}.${k}: expected ${JSON.stringify(s[k])} (source), actual ${JSON.stringify(w[k])}`);
		}
	}
	// secondary: source itself should carry the nominal spec values
	for (const k of ['shape', 'diameter', 'depth', 'totalLiquidVolume'] as const) {
		const same = k === 'shape' ? s[k] === NOMINAL[k] : sameNumber(s[k], NOMINAL[k]);
		if (!same) srcDriftNote.push(`${name}.${k}: source has ${JSON.stringify(s[k])}, spec says ${JSON.stringify(NOMINAL[k])}`);
	}
}
check(
	'6a',
	invBad.length === 0,
	'shape/diameter/depth/totalLiquidVolume exactly match source on all 24 wells',
	`${invBad.length} invariant mismatch(es) vs source`,
	invBad
);
check(
	'6b',
	srcDriftNote.length === 0,
	`source wells carry the spec values (circular, d=${NOMINAL.diameter}, depth=${NOMINAL.depth}, vol=${NOMINAL.totalLiquidVolume})`,
	`source deviates from the stated spec on ${srcDriftNote.length} field(s) — spec or source is wrong, investigate before trusting either`,
	srcDriftNote
);

// ── 7. column parity ─────────────────────────────────────────────────────────
console.log('\n[7] Column parity (reagent vs wax)');
// 7a — LABELS. Check whether the source encodes any wax/gate/reagent marker at all.
const sourceText = JSON.stringify(src);
const hasMarker = /(wax|gate|reagent)/i.test(sourceText);
if (!hasMarker) {
	skip(
		'7a',
		'source definition carries NO wax/gate/reagent marker anywhere (only geometry + wellBottomShape), ' +
			'so "even columns are Gate4/Gate3/Gate2/Gate1" cannot be verified against it — not asserting an invented label'
	);
} else {
	const artifactHasMarker = /(wax|gate|reagent)/i.test(JSON.stringify(def));
	check(
		'7a',
		artifactHasMarker,
		'source carries wax/gate/reagent markers and the artifact preserves them (inspect manually for correctness)',
		'source carries wax/gate/reagent markers but the artifact dropped them'
	);
}

// 7b — GEOMETRY. The parity signature the source DOES encode: z by column parity.
const srcOddZ = new Set<number>();
const srcEvenZ = new Set<number>();
for (const name of CART1) {
	const col = Number(name.slice(1));
	(col % 2 === 1 ? srcOddZ : srcEvenZ).add(srcWells[name].z);
}
const overlap = [...srcOddZ].filter((z) => srcEvenZ.has(z));
if (overlap.length > 0) {
	skip(
		'7b',
		`source odd/even column z-values overlap (${overlap.join(', ')}), so z carries no parity signal to verify`
	);
} else {
	const parityBad: string[] = [];
	for (const name of CART1) {
		const w = wells[name];
		if (!w) continue;
		const col = Number(name.slice(1));
		const allowed = col % 2 === 1 ? srcOddZ : srcEvenZ;
		const kind = col % 2 === 1 ? 'reagent (odd col)' : 'wax gate (even col)';
		if (!allowed.has(w.z)) {
			parityBad.push(
				`${name}: z=${JSON.stringify(w.z)} is not a valid ${kind} height {${[...allowed].join(', ')}}`
			);
		}
	}
	check(
		'7b',
		parityBad.length === 0,
		`odd columns sit at reagent heights {${[...srcOddZ].join(', ')}}, even columns at wax-gate height {${[...srcEvenZ].join(', ')}} — parity signature preserved`,
		`${parityBad.length} well(s) break the column-parity z signature`,
		parityBad
	);
}

// 7c — per-row reagent heights (A vs B/C), also derived from source.
const rowZBad: string[] = [];
for (const name of CART1) {
	const col = Number(name.slice(1));
	if (col % 2 !== 1) continue;
	const w = wells[name];
	if (!w) continue;
	if (!sameNumber(w.z, srcWells[name].z)) {
		rowZBad.push(`${name}: z=${JSON.stringify(w.z)}, source ${JSON.stringify(srcWells[name].z)}`);
	}
}
check(
	'7c',
	rowZBad.length === 0,
	`reagent-hole heights match source per row (A=${srcWells.A1.z}, B=${srcWells.B1.z}, C=${srcWells.C1.z})`,
	'reagent-hole heights deviate from source',
	rowZBad
);

// ── 8. ordering ──────────────────────────────────────────────────────────────
console.log('\n[8] Ordering');
const ordering = def.ordering;
if (!Array.isArray(ordering) || !ordering.every((c) => Array.isArray(c))) {
	fail('8', 'ordering is not an array of arrays');
} else {
	const flat = ordering.flat();
	const dupes = flat.filter((n, i) => flat.indexOf(n) !== i);
	const dangling = flat.filter((n) => !(n in wells));
	const uncovered = CART1.filter((n) => !flat.includes(n));
	check('8a', dangling.length === 0, 'every ordering entry references an existing well', 'ordering references non-existent wells', [...new Set(dangling)].map((n) => `ordering references ${n}, which is not in wells`));
	check('8b', dupes.length === 0, 'no duplicate entries in ordering', 'ordering contains duplicates', [...new Set(dupes)].map((n) => `duplicate ordering entry ${n}`));
	check('8c', uncovered.length === 0, 'ordering covers all 24 retained wells', 'ordering omits wells', uncovered.map((n) => `well ${n} never appears in ordering`));
	check('8d', flat.length === 24, 'ordering holds exactly 24 entries', `ordering holds ${flat.length} entries, expected 24`);
}

// ── 9. extra: groups must not dangle either ──────────────────────────────────
console.log('\n[9] Groups (extra check — dangling references)');
const groups = def.groups;
if (!Array.isArray(groups)) {
	fail('9', `groups is not an array (got ${JSON.stringify(groups)})`);
} else {
	const gWells = groups.flatMap((g) => g?.wells ?? []);
	const gDangling = [...new Set(gWells.filter((n) => !(n in wells)))];
	const gUncovered = CART1.filter((n) => !gWells.includes(n));
	check('9a', gDangling.length === 0, 'no group references a well that does not exist', 'groups reference non-existent wells', gDangling.map((n) => `group references ${n}, which is not in wells`));
	check('9b', gUncovered.length === 0, 'every retained well belongs to a group', 'wells absent from all groups', gUncovered.map((n) => `well ${n} is in no group`));
}

// ── verdict ──────────────────────────────────────────────────────────────────
console.log('\n─────────────────────────────────────────');
if (failures === 0) {
	console.log(`VERDICT: PASS — artifact is faithful to ${SOURCE_LOADNAME} cartridge 1${skipped ? ` (${skipped} check(s) skipped)` : ''}.`);
	process.exit(0);
} else {
	console.log(`VERDICT: FAIL — ${failures} check(s) failed${skipped ? `, ${skipped} skipped` : ''}:`);
	for (const d of detail) console.log(`  · ${d}`);
	process.exit(1);
}
