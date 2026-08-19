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

function dimsOf(def: any): { xMax: number; yMax: number; zMax: number } {
	const d = def?.definition?.dimensions ?? {};
	const x = Number(d.xDimension), y = Number(d.yDimension), z = Number(d.zDimension);
	return {
		xMax: Number.isFinite(x) && x > 0 ? x : Infinity,
		yMax: Number.isFinite(y) && y > 0 ? y : Infinity,
		zMax: Number.isFinite(z) && z > 0 ? z + Z_UPPER_MARGIN_MM : Infinity
	};
}

/** Returns a reason string if `after` is off the labware body, else null. */
function outOfBounds(after: Vec3, b: { xMax: number; yMax: number; zMax: number }): string | null {
	if (after.x < 0 || after.x > b.xMax) return `x ${after.x.toFixed(2)}mm outside the labware [0, ${b.xMax}]`;
	if (after.y < 0 || after.y > b.yMax) return `y ${after.y.toFixed(2)}mm outside the labware [0, ${b.yMax}]`;
	if (after.z < 0 || after.z > b.zMax) return `z ${after.z.toFixed(2)}mm outside the labware [0, ${Number.isFinite(b.zMax) ? b.zMax.toFixed(1) : '∞'}]`;
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
