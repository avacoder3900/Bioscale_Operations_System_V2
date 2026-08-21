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

// ── Positional bounds: CEILING AND XY NOT ENFORCED, FLOOR IS (2026-08-19).
//
// A hole may be moved arbitrarily high, and anywhere in XY, so the pipette can
// dispense into a raised location on the new cartridge deck. That freedom is the
// whole point of the 2026-08-18 change and is preserved exactly.
//
// What is enforced again is the FLOOR, and only the floor. Below the deck's bottom
// plane there is no hole to dispense into — just the slot, and the tip. That is the
// one direction where "unrestricted" means "crash" rather than "reach".
//
// The floor is derived from the deck's OWN `dimensions` in the labware JSON, never
// from its holes. `dimensions` describes the physical block: the frame's origin is
// the deck's bottom face and `zDimension` is how tall the block stands. Hole x/y/z
// are LOCATIONS INSIDE that frame, so they are exactly what must not be trusted to
// define the limit — an edited or crept hole would drag the floor down with it.
// (Same reasoning as safeArcZ, which is derived from dimensions.z and not from
// max(well.z), after a deck whose wells had crept to 82mm produced an arc height
// past the gantry limit.)
//
// Still yours to verify manually, unchanged from the 2026-08-18 note:
//   • The OT-2 labware schema wants 0 ≤ x ≤ xDimension, 0 ≤ y ≤ yDimension. A coord
//     outside that can make the robot reject the WHOLE definition at registration,
//     silently breaking move-to-hole for every deck that loads it (the 2026-06
//     deck-003 row-A bug). XY is still unbounded here.
//   • Gross upward Z runaway still feeds the arc-height math.
// Verify a moved hole on the robot before trusting a deck in production.

/** The deck's bottom face, in the labware frame `dimensions` measures up from. */
const DECK_FLOOR_Z = 0;

/**
 * Reject-never-clamp floor check. Returns an operator-readable reason, or null when
 * the coordinate is fine. Clamping is deliberately not offered: silently moving a
 * hole to a Z the operator did not ask for is how a tip ends up somewhere nobody
 * predicted.
 */
function belowDeckFloor(after: Vec3, def: any): string | null {
	if (!(after.z < DECK_FLOOR_Z)) return null;
	const h = Number(def?.definition?.dimensions?.zDimension);
	const deck = Number.isFinite(h) && h > 0 ? `${h}mm-tall deck` : 'deck';
	return `z ${after.z.toFixed(2)}mm is below the ${deck}'s floor (${DECK_FLOOR_Z}mm) — the tip would be driven into the slot, not into a hole. Raising a hole is unrestricted; lowering it past the deck bottom is not.`;
}

// ── Original 2026-08-18 note, kept for provenance:
// Positional bounds: INTENTIONALLY NOT ENFORCED (2026-08-18, by request).
// Fill holes may be moved to any coordinate — negative, past xDimension/yDimension,
// or arbitrarily high in Z. The only validation left is numeric sanity (`n()` below
// coerces non-finite input to 0), so a well always ends up with real numbers.
//
// What this used to guard, and what you now own manually:
//   • The OT-2 labware schema wants 0 ≤ x ≤ xDimension, 0 ≤ y ≤ yDimension, 0 ≤ z.
//     A coord outside that can make the robot reject the WHOLE definition at
//     registration, which silently breaks move-to-hole for every deck that loads it
//     (the 2026-06 deck-003 row-A bug).
//   • Gross Z runaway (e.g. 82mm on a 12.7mm deck) feeds the arc-height math and
//     produced the "Arc out of bounds in Z" gantry error.
// Both are now possible again on purpose. Verify a moved hole on the robot before
// trusting a deck in production.

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

	const floorErr = belowDeckFloor(after, def);
	if (floorErr) throw new Error(`Well "${wellName}": ${floorErr}`);

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
		const floorErr = belowDeckFloor(after, def);
		if (floorErr) {
			failed.push({ wellName, reason: floorErr });
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
		const floorErr = belowDeckFloor(after, def);
		if (floorErr) {
			failed.push({ wellName, reason: floorErr });
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
