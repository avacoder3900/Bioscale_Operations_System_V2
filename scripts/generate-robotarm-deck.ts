/**
 * generate-robotarm-deck.ts — build the "Robot Arm Deck" labware definition.
 *
 * The Robot Arm Deck is the gen4 cartridge deck reduced to a single cartridge:
 * cartridge 1 only (rows A,B,C x columns 1..8 = 24 wells; 12 reagent holes on
 * the odd columns, 12 wax gates on the even columns). Deck geometry is NOT
 * recomputed — footprint dimensions, cornerOffsetFromSlot and every retained
 * well's absolute x/y/z are copied byte-for-byte out of the source definition
 * so the deck still drops into OT-2 slot 1 exactly where gen4deck did.
 *
 * Source of truth (read-only):
 *   backups/labware-defs-backup-2026-07-28-pre-waxwell-restore.json
 *
 * Output (bare Opentrons schemaVersion-2 labware definition, i.e. the shape
 * POST /api/opentrons-lab/labware expects as its multipart "labwareFile"):
 *   labware/robotarm_cartridge_deck_001.json
 *
 * The only hand-written values here are the new identity strings. The script
 * touches no database, no API and no audit log — the user uploads the emitted
 * JSON through the BIMS UI. Output is deterministic: re-running is a no-op diff.
 *
 * Run: npx tsx scripts/generate-robotarm-deck.ts
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const SOURCE_BACKUP = resolve(
	REPO_ROOT,
	'backups/labware-defs-backup-2026-07-28-pre-waxwell-restore.json'
);
const OUTPUT_FILE = resolve(REPO_ROOT, 'labware/robotarm_cartridge_deck_001.json');

/** Row in the backup whose definition supplies all geometry. */
const SOURCE_LOAD_NAME = 'gen4deck_gen7cartridge_001';

/** Cartridge 1 = 3 channel rows x 8 columns. Order matters: it drives `ordering`. */
const CART1_ROWS = ['A', 'B', 'C'] as const;
const CART1_COLS = [1, 2, 3, 4, 5, 6, 7, 8] as const;

/** New identity — the only hand-written strings in the output. */
const NEW_NAMESPACE = 'cosmas_damian';
const NEW_LOAD_NAME = 'robotarm_cartridge_deck_001'; // contains "cartridge_deck" so the studio's DECK_RE matches
const NEW_VERSION = 1;
const NEW_DISPLAY_NAME = 'Robot Arm Deck 1 Cartridge Gen7 v1 001';
const NEW_DISPLAY_CATEGORY = 'wellPlate';

/** Expected well geometry, asserted rather than assumed. */
const WELL_SHAPE = 'circular';
const WELL_DIAMETER = 1.8;
const WELL_DEPTH = 3.75;
const WELL_VOLUME = 18;
const Z_WAX = 3.3; // even columns — wax gates (Gate4/Gate3/Gate2/Gate1 on cols 2/4/6/8)
const Z_REAGENT_ROW_A = 8.700000000000001; // odd columns, row A
const Z_REAGENT_ROW_BC = 8.200000000000001; // odd columns, rows B/C

interface Well {
	depth: number;
	totalLiquidVolume: number;
	shape: string;
	diameter: number;
	x: number;
	y: number;
	z: number;
}

interface LabwareDefinitionSV2 {
	ordering: string[][];
	brand: Record<string, unknown>;
	metadata: Record<string, unknown>;
	dimensions: Record<string, unknown>;
	wells: Record<string, Well>;
	groups: { metadata: Record<string, unknown>; wells: string[] }[];
	parameters: Record<string, unknown>;
	namespace: string;
	version: number;
	schemaVersion: number;
	cornerOffsetFromSlot: Record<string, unknown>;
}

interface BackupRow {
	loadName?: string;
	definition?: LabwareDefinitionSV2;
}

function fail(message: string): never {
	throw new Error(`generate-robotarm-deck: ${message}`);
}

function loadSource(): LabwareDefinitionSV2 {
	if (!existsSync(SOURCE_BACKUP)) fail(`source backup not found at ${SOURCE_BACKUP}`);
	const parsed: unknown = JSON.parse(readFileSync(SOURCE_BACKUP, 'utf8'));
	if (!Array.isArray(parsed)) fail('source backup is not a JSON array');
	const row = (parsed as BackupRow[]).find((r) => r?.loadName === SOURCE_LOAD_NAME);
	if (!row?.definition) fail(`no row with loadName "${SOURCE_LOAD_NAME}" in source backup`);
	const def = row.definition;
	if (def.schemaVersion !== 2) fail(`source schemaVersion is ${def.schemaVersion}, expected 2`);
	if (!def.wells || typeof def.wells !== 'object') fail('source definition has no wells');
	if (!Array.isArray(def.groups) || def.groups.length !== 1) {
		fail(`expected exactly 1 well group in source, got ${def.groups?.length}`);
	}
	return def;
}

/** Copy a well with a fixed key order and exact (uncomputed) coordinates. */
function copyWell(src: Well): Well {
	return {
		depth: src.depth,
		totalLiquidVolume: src.totalLiquidVolume,
		shape: src.shape,
		diameter: src.diameter,
		x: src.x,
		y: src.y,
		z: src.z
	};
}

/** Guard the assumptions this deck is built on; a surprise must stop the build. */
function assertWellGeometry(name: string, row: string, col: number, well: Well): void {
	const bad = (what: string, got: unknown, want: unknown) =>
		fail(`well ${name}: ${what} is ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);

	if (well.shape !== WELL_SHAPE) bad('shape', well.shape, WELL_SHAPE);
	if (well.diameter !== WELL_DIAMETER) bad('diameter', well.diameter, WELL_DIAMETER);
	if (well.depth !== WELL_DEPTH) bad('depth', well.depth, WELL_DEPTH);
	if (well.totalLiquidVolume !== WELL_VOLUME) bad('totalLiquidVolume', well.totalLiquidVolume, WELL_VOLUME);

	const isWax = col % 2 === 0;
	const expectedZ = isWax ? Z_WAX : row === 'A' ? Z_REAGENT_ROW_A : Z_REAGENT_ROW_BC;
	if (well.z !== expectedZ) bad(isWax ? 'wax-gate z' : 'reagent z', well.z, expectedZ);

	for (const axis of ['x', 'y', 'z'] as const) {
		if (typeof well[axis] !== 'number' || !Number.isFinite(well[axis])) {
			bad(`${axis} coordinate`, well[axis], 'a finite number');
		}
	}
}

function build(source: LabwareDefinitionSV2): LabwareDefinitionSV2 {
	// Column-major ordering, matching the source convention (ordering[col] = rows).
	const ordering: string[][] = CART1_COLS.map((col) => CART1_ROWS.map((row) => `${row}${col}`));
	const retained = ordering.flat();

	const wells: Record<string, Well> = {};
	for (const col of CART1_COLS) {
		for (const row of CART1_ROWS) {
			const name = `${row}${col}`;
			const src = source.wells[name];
			if (!src) fail(`source definition is missing well ${name}`);
			assertWellGeometry(name, row, col, src);
			wells[name] = copyWell(src);
		}
	}
	if (Object.keys(wells).length !== retained.length) {
		fail(`built ${Object.keys(wells).length} wells, expected ${retained.length}`);
	}

	const sourceGroup = source.groups[0];
	for (const name of retained) {
		if (!sourceGroup.wells.includes(name)) fail(`well ${name} is not in the source well group`);
	}

	return {
		ordering,
		brand: source.brand,
		metadata: {
			...source.metadata,
			displayName: NEW_DISPLAY_NAME,
			displayCategory: NEW_DISPLAY_CATEGORY
		},
		dimensions: source.dimensions,
		wells,
		groups: [{ metadata: sourceGroup.metadata, wells: retained }],
		parameters: { ...source.parameters, loadName: NEW_LOAD_NAME },
		namespace: NEW_NAMESPACE,
		version: NEW_VERSION,
		schemaVersion: 2,
		cornerOffsetFromSlot: source.cornerOffsetFromSlot
	};
}

const source = loadSource();
const definition = build(source);
const serialized = `${JSON.stringify(definition, null, 2)}\n`;

mkdirSync(dirname(OUTPUT_FILE), { recursive: true });
const unchanged = existsSync(OUTPUT_FILE) && readFileSync(OUTPUT_FILE, 'utf8') === serialized;
writeFileSync(OUTPUT_FILE, serialized, 'utf8');

const waxWells = Object.keys(definition.wells).filter((n) => Number(n.slice(1)) % 2 === 0);
console.log(`${unchanged ? 'unchanged' : 'wrote'}: ${OUTPUT_FILE}`);
console.log(
	`  ${definition.namespace}/${definition.parameters.loadName} v${definition.version} — ` +
		`${Object.keys(definition.wells).length} wells ` +
		`(${waxWells.length} wax gates, ${Object.keys(definition.wells).length - waxWells.length} reagent), ` +
		`${definition.ordering.length} columns`
);
console.log(
	`  footprint ${JSON.stringify(definition.dimensions)} — geometry copied from ${SOURCE_LOAD_NAME}`
);
