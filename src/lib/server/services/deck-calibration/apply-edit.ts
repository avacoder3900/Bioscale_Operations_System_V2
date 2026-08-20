/**
 * CALIB-1-2: apply one deck-JSON hole nudge.
 *
 * Mongo `labware_definitions` is the source of truth (it's what gets bundled to
 * the robot at protocol upload). We:
 *   1. read the well's current x/y/z (before),
 *   2. write after = before + delta into the Mongo definition,
 *   3. append a DeckCalibrationEdit history row + AuditLog,
 *   4. best-effort: mirror the change into the local Opentrons labware JSON file
 *      (lab-Mac only — skipped when the dir is absent, e.g. on Vercel).
 */
import fs from 'node:fs';
import path from 'node:path';
import {
	connectDB,
	LabwareDefinition,
	DeckCalibrationEdit,
	AuditLog,
	generateId
} from '$lib/server/db';
import { resolveLabwareDefinition } from './resolve';
import { markUnpublished } from './deck-versions';

const LABWARE_DIR =
	process.env.OPENTRONS_LABWARE_DIR ||
	`${process.env.HOME ?? ''}/Library/Application Support/Opentrons/labware`;

export interface Vec3 {
	x: number;
	y: number;
	z: number;
}

export interface ApplyDeckEditInput {
	deckLoadName: string;
	wellName: string;
	delta: Vec3;
	user: { _id?: string; username?: string };
	robotId?: string | null;
	deckEquipmentId?: string | null;
}

export interface ApplyDeckEditResult {
	before: Vec3;
	after: Vec3;
	fileSynced: boolean;
}

const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// ── Physical-bounds backstop. NOT a magnitude cap (corrections can be large) — this
// rejects only edits that push a well OFF the labware's own body. The OT-2 labware
// schema requires every well coord within the labware: 0 ≤ x ≤ xDimension,
// 0 ≤ y ≤ yDimension, 0 ≤ z. A jog past an edge (e.g. y = −0.5) makes the WHOLE def
// fail registration on the robot ("Input should be a valid integer" / "≥ 0"), which
// silently breaks move-to-hole wherever that deck is loaded (the 2026-06 deck-003
// row-A bug). Z keeps a generous upper margin (catches gross runaway like deck-004's
// 82mm-on-a-12.7mm-deck). Real holes are always well inside, so nothing legit is blocked.
const Z_UPPER_MARGIN_MM = 40;

// Mirrors ARC_CEILING_MM in deck-calibration/+page.svelte: the OT-2 left p300
// rejects gantry Z past ~170mm and a Biotix tip adds 52.0mm, so the critical
// point must stay under ~115mm. A deck taller than the arc that is supposed to
// clear it is not a deck the robot can fly over.
const ARC_CEILING_MM = 115;
const MIN_ARC_CLEARANCE_MM = 10;

/**
 * The highest a well may be declared and still be reachable. Z_UPPER_MARGIN_MM is
 * DECK-relative — it rises with zDimension — so on its own it would accept a well
 * above the gantry ceiling as soon as a deck is raised, certifying geometry the
 * safe arc cannot clear (at zDimension 105 it would allow a well at 145mm while
 * the arc caps at 115). The machine bound does not move with the deck; take
 * whichever binds first.
 */
const MAX_FLYABLE_WELL_Z_MM = ARC_CEILING_MM - MIN_ARC_CLEARANCE_MM;

function dimsOf(def: any): { xMax: number; yMax: number; zMax: number } {
	const d = def?.definition?.dimensions ?? {};
	const x = Number(d.xDimension), y = Number(d.yDimension), z = Number(d.zDimension);
	const deckBound = Number.isFinite(z) && z > 0 ? z + Z_UPPER_MARGIN_MM : Infinity;
	return {
		xMax: Number.isFinite(x) && x > 0 ? x : Infinity,
		yMax: Number.isFinite(y) && y > 0 ? y : Infinity,
		zMax: Math.min(deckBound, MAX_FLYABLE_WELL_Z_MM)
	};
}

/** Returns a reason string if `after` is off the labware body, else null. */
function outOfBounds(after: Vec3, b: { xMax: number; yMax: number; zMax: number }): string | null {
	if (after.x < 0 || after.x > b.xMax) return `x ${after.x.toFixed(2)}mm outside the labware [0, ${b.xMax}]`;
	if (after.y < 0 || after.y > b.yMax) return `y ${after.y.toFixed(2)}mm outside the labware [0, ${b.yMax}]`;
	if (after.z < 0 || after.z > b.zMax) {
		// Name WHICH ceiling bit: "outside the labware" is wrong and misleading when
		// it was the gantry that bound, and the fix is different (lower the well vs
		// lower the whole deck).
		const why = b.zMax >= MAX_FLYABLE_WELL_Z_MM ? 'gantry ceiling' : 'labware height + margin';
		return `z ${after.z.toFixed(2)}mm outside [0, ${Number.isFinite(b.zMax) ? b.zMax.toFixed(1) : 'inf'}] (${why})`;
	}
	return null;
}

export async function applyDeckEdit(input: ApplyDeckEditInput): Promise<ApplyDeckEditResult> {
	await connectDB();
	const { deckLoadName, wellName } = input;
	const delta: Vec3 = { x: n(input.delta?.x), y: n(input.delta?.y), z: n(input.delta?.z) };

	// Resolve by the full identity, not the bare loadName: labware_definitions is
	// uniquely indexed on (namespace, loadName, version), so a loadName alone can
	// legitimately match several documents and `findOne` would pick arbitrarily.
	const { doc: def } = await resolveLabwareDefinition(deckLoadName, { strict: true });
	const well = def.definition?.wells?.[wellName];
	if (!well) throw new Error(`Well "${wellName}" not found in "${deckLoadName}".`);

	const before: Vec3 = { x: n(well.x), y: n(well.y), z: n(well.z) };
	const after: Vec3 = { x: before.x + delta.x, y: before.y + delta.y, z: before.z + delta.z };

	// Physical-bounds backstop (no magnitude cap — corrections can be large).
	const oob = outOfBounds(after, dimsOf(def));
	if (oob) {
		throw new Error(
			`Rejected: ${wellName} ${oob}. A well can't be moved off the deck's physical body ` +
				`(the robot rejects the whole def otherwise). Re-capture within the labware.`
		);
	}

	// 1. Mongo source of truth — set the well's coords (Mixed sub-path).
	await LabwareDefinition.updateOne(
		{ _id: def._id },
		{
			$set: {
				[`definition.wells.${wellName}.x`]: after.x,
				[`definition.wells.${wellName}.y`]: after.y,
				[`definition.wells.${wellName}.z`]: after.z
			}
		}
	);
	await markUnpublished(deckLoadName);

	// 2. Append-only history.
	await DeckCalibrationEdit.create({
		_id: generateId(),
		deckLoadName,
		deckEquipmentId: input.deckEquipmentId ?? null,
		wellName,
		delta,
		before,
		after,
		robotId: input.robotId ?? null,
		createdBy: input.user?.username,
		createdAt: new Date()
	});

	await AuditLog.create({
		_id: generateId(),
		tableName: 'labware_definitions',
		recordId: deckLoadName,
		action: 'deck_calibration_edit',
		newData: { wellName, delta, before, after, robotId: input.robotId ?? null },
		changedAt: new Date(),
		changedBy: input.user?.username
	});

	// 3. Best-effort local-file mirror (lab Mac). Mongo already committed.
	let fileSynced = false;
	try {
		if (fs.existsSync(LABWARE_DIR)) {
			for (const f of fs.readdirSync(LABWARE_DIR).filter((x) => x.endsWith('.json'))) {
				const fp = path.join(LABWARE_DIR, f);
				try {
					const json = JSON.parse(fs.readFileSync(fp, 'utf8'));
					if (json?.parameters?.loadName === deckLoadName) {
						if (json.wells?.[wellName]) {
							json.wells[wellName].x = after.x;
							json.wells[wellName].y = after.y;
							json.wells[wellName].z = after.z;
							fs.writeFileSync(fp, JSON.stringify(json, null, 2));
							fileSynced = true;
						}
						break;
					}
				} catch {
					/* skip unparseable file */
				}
			}
		}
	} catch {
		/* best-effort — Mongo is source of truth */
	}

	return { before, after, fileSynced };
}

// ── Deck HEIGHT edits ────────────────────────────────────────────────────────
//
// `dimensions.zDimension` is the one geometry field nothing could write. That was
// fine while every deck was 12.7mm, and blocking as soon as one isn't: the well
// guard above derives its Z ceiling from zDimension, and — more importantly — the
// OT-2 plans its own default arcs and collision checks from zDimension. Declaring
// a 12.7mm block while holes sit at 60mm means the robot believes it may travel
// low, and it will drag a tip through the raised structure.
//
// Same append-with-history contract as a well edit: Mongo, markUnpublished, a
// DeckCalibrationEdit row, an AuditLog row, best-effort local-file mirror.

/**
 * Reserved `wellName` for a dimensions edit. `DeckCalibrationEdit.wellName` is
 * required, and a height change belongs in the same history stream as the hole
 * changes — reconstructing "why did this deck move" needs both in one timeline.
 * `before`/`after` carry the full dimensions triple rather than a well's coords.
 */
export const DIMENSIONS_EDIT_WELL = '__dimensions__';

export interface ApplyDeckDimensionEditInput {
	deckLoadName: string;
	/** Absolute new zDimension in mm. x/y are optional and rarely change. */
	zDimension: number;
	xDimension?: number;
	yDimension?: number;
	user: { _id?: string; username?: string };
	robotId?: string | null;
	deckEquipmentId?: string | null;
}

export interface ApplyDeckDimensionEditResult {
	before: Vec3;
	after: Vec3;
	fileSynced: boolean;
	/** New well-edit ceiling implied by the height, for the caller to surface. */
	editCeiling: number;
	/** New safe-arc height implied by the height. */
	safeArcZ: number;
}

export async function applyDeckDimensionEdit(
	input: ApplyDeckDimensionEditInput
): Promise<ApplyDeckDimensionEditResult> {
	await connectDB();
	const { deckLoadName } = input;

	const { doc: def } = await resolveLabwareDefinition(deckLoadName, { strict: true });
	const dims = def.definition?.dimensions ?? {};

	const before: Vec3 = { x: n(dims.xDimension), y: n(dims.yDimension), z: n(dims.zDimension) };
	const after: Vec3 = {
		x: input.xDimension === undefined ? before.x : n(input.xDimension),
		y: input.yDimension === undefined ? before.y : n(input.yDimension),
		z: n(input.zDimension)
	};

	// 1. A dimension is an extent, not a coordinate — zero or negative is nonsense.
	if (!(after.z > 0)) {
		throw new Error(`Rejected: zDimension must be greater than 0 (got ${after.z}).`);
	}

	// 2. The deck must still contain its own holes. Lowering a deck below a hole
	//    orphans that hole outside the labware body, which makes the robot reject
	//    the WHOLE definition at registration — the same failure mode the well
	//    guard exists to prevent, arrived at from the other direction.
	const wells: [string, any][] = Object.entries(def.definition?.wells ?? {});
	const orphaned = wells
		.map(([name, w]) => ({ name, top: n(w.z) + n(w.depth) }))
		.filter((w) => w.top > after.z + 1e-6);
	if (orphaned.length) {
		const shown = orphaned
			.slice(0, 5)
			.map((w) => `${w.name} (${w.top.toFixed(2)}mm)`)
			.join(', ');
		throw new Error(
			`Rejected: zDimension ${after.z.toFixed(2)}mm is below ${orphaned.length} hole top(s) — ` +
				`${shown}${orphaned.length > 5 ? `, +${orphaned.length - 5} more` : ''}. ` +
				`Every well must satisfy z + depth <= zDimension. Lower the holes first, or raise the height.`
		);
	}

	// 3. The tip has to be able to clear it. Reject with the deficit named rather
	//    than accept a deck the safe arc cannot fly over.
	const maxHeight = MAX_FLYABLE_WELL_Z_MM;
	if (after.z > maxHeight) {
		throw new Error(
			`Rejected: zDimension ${after.z.toFixed(2)}mm exceeds the flyable maximum ${maxHeight}mm ` +
				`(arc ceiling ${ARC_CEILING_MM}mm − ${MIN_ARC_CLEARANCE_MM}mm minimum clearance) ` +
				`by ${(after.z - maxHeight).toFixed(2)}mm. The pipette could not travel over this deck.`
		);
	}

	// 1. Mongo source of truth.
	await LabwareDefinition.updateOne(
		{ _id: def._id },
		{
			$set: {
				'definition.dimensions.xDimension': after.x,
				'definition.dimensions.yDimension': after.y,
				'definition.dimensions.zDimension': after.z
			}
		}
	);
	// definitionHash covers the whole definition, dimensions included, so the
	// version machinery already sees this as a geometry change.
	await markUnpublished(deckLoadName);

	// 2. Append-only history — same stream as the hole edits.
	await DeckCalibrationEdit.create({
		_id: generateId(),
		deckLoadName,
		deckEquipmentId: input.deckEquipmentId ?? null,
		wellName: DIMENSIONS_EDIT_WELL,
		delta: { x: after.x - before.x, y: after.y - before.y, z: after.z - before.z },
		before,
		after,
		robotId: input.robotId ?? null,
		createdBy: input.user?.username,
		createdAt: new Date()
	});

	await AuditLog.create({
		_id: generateId(),
		tableName: 'labware_definitions',
		recordId: deckLoadName,
		action: 'deck_dimension_edit',
		newData: { before, after, robotId: input.robotId ?? null },
		changedAt: new Date(),
		changedBy: input.user?.username
	});

	// 3. Best-effort local-file mirror (lab Mac). Mongo already committed.
	let fileSynced = false;
	try {
		if (fs.existsSync(LABWARE_DIR)) {
			for (const f of fs.readdirSync(LABWARE_DIR).filter((x) => x.endsWith('.json'))) {
				const fp = path.join(LABWARE_DIR, f);
				try {
					const json = JSON.parse(fs.readFileSync(fp, 'utf8'));
					if (json?.parameters?.loadName === deckLoadName) {
						json.dimensions = {
							...(json.dimensions ?? {}),
							xDimension: after.x,
							yDimension: after.y,
							zDimension: after.z
						};
						fs.writeFileSync(fp, JSON.stringify(json, null, 2));
						fileSynced = true;
						break;
					}
				} catch {
					/* skip unparseable file */
				}
			}
		}
	} catch {
		/* best-effort — Mongo is source of truth */
	}

	return {
		before,
		after,
		fileSynced,
		editCeiling: after.z + Z_UPPER_MARGIN_MM,
		safeArcZ: Math.min(Math.round(after.z + 80), ARC_CEILING_MM)
	};
}

export interface ApplyDeckEditBatchInput {
	deckLoadName: string;
	wellNames: string[];
	delta: Vec3;
	user: { _id?: string; username?: string };
	robotId?: string | null;
	deckEquipmentId?: string | null;
}

export interface ApplyDeckEditBatchResult {
	applied: number;
	failed: { wellName: string; reason: string }[];
	fileSynced: boolean;
	results: { wellName: string; before: Vec3; after: Vec3 }[];
}

/**
 * Apply the SAME delta to many wells in one shot (group calibration). One Mongo
 * read + one write + batch history insert + one local-file pass — so jogging once
 * and applying to a whole cartridge (or several) is cheap. Per-well history is
 * still recorded in DeckCalibrationEdit; AuditLog gets one summary row.
 */
export async function applyDeckEditBatch(
	input: ApplyDeckEditBatchInput
): Promise<ApplyDeckEditBatchResult> {
	await connectDB();
	const { deckLoadName } = input;
	const delta: Vec3 = { x: n(input.delta?.x), y: n(input.delta?.y), z: n(input.delta?.z) };
	const wellNames = Array.from(new Set(input.wellNames ?? []));

	// Resolve by the full identity, not the bare loadName: labware_definitions is
	// uniquely indexed on (namespace, loadName, version), so a loadName alone can
	// legitimately match several documents and `findOne` would pick arbitrarily.
	const { doc: def } = await resolveLabwareDefinition(deckLoadName, { strict: true });
	const wells = def.definition?.wells ?? {};
	const dims = dimsOf(def);

	const now = new Date();
	const failed: { wellName: string; reason: string }[] = [];
	const results: { wellName: string; before: Vec3; after: Vec3 }[] = [];
	const setOps: Record<string, number> = {};
	const historyDocs: any[] = [];

	for (const wellName of wellNames) {
		const well = wells[wellName];
		if (!well) {
			failed.push({ wellName, reason: 'well not found' });
			continue;
		}
		const before: Vec3 = { x: n(well.x), y: n(well.y), z: n(well.z) };
		const after: Vec3 = { x: before.x + delta.x, y: before.y + delta.y, z: before.z + delta.z };
		const oob = outOfBounds(after, dims);
		if (oob) {
			failed.push({ wellName, reason: oob });
			continue;
		}
		setOps[`definition.wells.${wellName}.x`] = after.x;
		setOps[`definition.wells.${wellName}.y`] = after.y;
		setOps[`definition.wells.${wellName}.z`] = after.z;
		results.push({ wellName, before, after });
		historyDocs.push({
			_id: generateId(),
			deckLoadName,
			deckEquipmentId: input.deckEquipmentId ?? null,
			wellName,
			delta,
			before,
			after,
			robotId: input.robotId ?? null,
			createdBy: input.user?.username,
			createdAt: now
		});
	}

	// ALL-OR-NOTHING: a batch that can only partly apply must not apply at all.
	// Partial application tears the group's internal geometry apart — the classic
	// case is a row clamping at the y=0 edge while the rest of the deck moves,
	// after which the dropped wells are permanently offset from their neighbors
	// (and a subsequent Undo moves them AGAIN). This exact mechanism corrupted
	// deck calibrations repeatedly (2026-07: "calibration keeps getting messed
	// up"). Fail loudly with the per-well reasons instead; the operator
	// re-captures with a delta that fits every selected well.
	if (failed.length > 0) {
		return { applied: 0, failed, fileSynced: false, results: [] };
	}
	if (results.length === 0) {
		return { applied: 0, failed, fileSynced: false, results };
	}

	// 1. One Mongo write for every well's coords.
	await LabwareDefinition.updateOne({ _id: def._id }, { $set: setOps });
	await markUnpublished(deckLoadName);

	// 2. Batch history + one summary audit row.
	await DeckCalibrationEdit.insertMany(historyDocs);
	await AuditLog.create({
		_id: generateId(),
		tableName: 'labware_definitions',
		recordId: deckLoadName,
		action: 'deck_calibration_edit_batch',
		newData: { delta, wellCount: results.length, wells: results.map((r) => r.wellName), robotId: input.robotId ?? null },
		changedAt: now,
		changedBy: input.user?.username
	});

	// 3. One best-effort local-file mirror pass for all wells.
	let fileSynced = false;
	try {
		if (fs.existsSync(LABWARE_DIR)) {
			for (const f of fs.readdirSync(LABWARE_DIR).filter((x) => x.endsWith('.json'))) {
				const fp = path.join(LABWARE_DIR, f);
				try {
					const json = JSON.parse(fs.readFileSync(fp, 'utf8'));
					if (json?.parameters?.loadName === deckLoadName) {
						for (const r of results) {
							if (json.wells?.[r.wellName]) {
								json.wells[r.wellName].x = r.after.x;
								json.wells[r.wellName].y = r.after.y;
								json.wells[r.wellName].z = r.after.z;
							}
						}
						fs.writeFileSync(fp, JSON.stringify(json, null, 2));
						fileSynced = true;
						break;
					}
				} catch {
					/* skip unparseable file */
				}
			}
		}
	} catch {
		/* best-effort — Mongo is source of truth */
	}

	return { applied: results.length, failed, fileSynced, results };
}

export interface ApplyDeckEditsPerWellInput {
	deckLoadName: string;
	edits: { wellName: string; delta: Vec3 }[];
	user: { _id?: string; username?: string };
	robotId?: string | null;
	deckEquipmentId?: string | null;
}

/**
 * Apply a DIFFERENT delta to each well in one shot (grid alignment — e.g. the
 * "Align cartridge to a reference hole" tool, where every hole snaps by its own
 * amount). Same guarantees as applyDeckEditBatch: one Mongo read + one write,
 * per-well DeckCalibrationEdit history (each row carries its own delta), one
 * summary AuditLog, physical-bounds guard per well, best-effort local mirror.
 */
export async function applyDeckEditsPerWell(
	input: ApplyDeckEditsPerWellInput
): Promise<ApplyDeckEditBatchResult> {
	await connectDB();
	const { deckLoadName } = input;
	// Last edit wins if a well is listed twice.
	const editMap = new Map<string, Vec3>();
	for (const e of input.edits ?? []) {
		if (e?.wellName) editMap.set(e.wellName, { x: n(e.delta?.x), y: n(e.delta?.y), z: n(e.delta?.z) });
	}

	// Resolve by the full identity, not the bare loadName: labware_definitions is
	// uniquely indexed on (namespace, loadName, version), so a loadName alone can
	// legitimately match several documents and `findOne` would pick arbitrarily.
	const { doc: def } = await resolveLabwareDefinition(deckLoadName, { strict: true });
	const wells = def.definition?.wells ?? {};
	const dims = dimsOf(def);

	const now = new Date();
	const failed: { wellName: string; reason: string }[] = [];
	const results: { wellName: string; before: Vec3; after: Vec3 }[] = [];
	const setOps: Record<string, number> = {};
	const historyDocs: any[] = [];

	for (const [wellName, delta] of editMap) {
		const well = wells[wellName];
		if (!well) {
			failed.push({ wellName, reason: 'well not found' });
			continue;
		}
		const before: Vec3 = { x: n(well.x), y: n(well.y), z: n(well.z) };
		const after: Vec3 = { x: before.x + delta.x, y: before.y + delta.y, z: before.z + delta.z };
		const oob = outOfBounds(after, dims);
		if (oob) {
			failed.push({ wellName, reason: oob });
			continue;
		}
		setOps[`definition.wells.${wellName}.x`] = after.x;
		setOps[`definition.wells.${wellName}.y`] = after.y;
		setOps[`definition.wells.${wellName}.z`] = after.z;
		results.push({ wellName, before, after });
		historyDocs.push({
			_id: generateId(),
			deckLoadName,
			deckEquipmentId: input.deckEquipmentId ?? null,
			wellName,
			delta,
			before,
			after,
			robotId: input.robotId ?? null,
			createdBy: input.user?.username,
			createdAt: now
		});
	}

	if (results.length === 0) {
		return { applied: 0, failed, fileSynced: false, results };
	}

	await LabwareDefinition.updateOne({ _id: def._id }, { $set: setOps });
	await markUnpublished(deckLoadName);
	await DeckCalibrationEdit.insertMany(historyDocs);
	await AuditLog.create({
		_id: generateId(),
		tableName: 'labware_definitions',
		recordId: deckLoadName,
		action: 'deck_calibration_edit_batch',
		newData: {
			mode: 'per-well',
			wellCount: results.length,
			wells: results.map((r) => r.wellName),
			robotId: input.robotId ?? null
		},
		changedAt: now,
		changedBy: input.user?.username
	});

	// Best-effort local-file mirror pass (lab Mac). Mongo already committed.
	let fileSynced = false;
	try {
		if (fs.existsSync(LABWARE_DIR)) {
			for (const f of fs.readdirSync(LABWARE_DIR).filter((x) => x.endsWith('.json'))) {
				const fp = path.join(LABWARE_DIR, f);
				try {
					const json = JSON.parse(fs.readFileSync(fp, 'utf8'));
					if (json?.parameters?.loadName === deckLoadName) {
						for (const r of results) {
							if (json.wells?.[r.wellName]) {
								json.wells[r.wellName].x = r.after.x;
								json.wells[r.wellName].y = r.after.y;
								json.wells[r.wellName].z = r.after.z;
							}
						}
						fs.writeFileSync(fp, JSON.stringify(json, null, 2));
						fileSynced = true;
						break;
					}
				} catch {
					/* skip unparseable file */
				}
			}
		}
	} catch {
		/* best-effort — Mongo is source of truth */
	}

	return { applied: results.length, failed, fileSynced, results };
}

/** Recent per-hole edit history for a deck (for the tuner page). */
export async function deckEditHistory(deckLoadName: string, limit = 100) {
	await connectDB();
	return (await DeckCalibrationEdit.find({ deckLoadName })
		.sort({ createdAt: -1 })
		.limit(limit)
		.lean()) as any[];
}
