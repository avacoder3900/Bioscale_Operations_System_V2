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

// ── Sanity bounds (prevents geometry runaway like the 2026-06 deck-004 Z-shift) ──
// A real per-hole calibration nudge is sub-mm to a few mm. Anything larger is
// almost always a bad capture (e.g. a tip-length frame mismatch ≈ 35-50mm), so we
// refuse it rather than silently corrupting the deck geometry.
const MAX_NUDGE_MM = 15;
// After an edit a well's z must stay within the labware's own physical height band.
// The deck def's zDimension is the real ceiling (deck = 12.7mm; a well at 82mm is
// physically impossible). Margin allows legit small overshoot; skipped if unknown.
const Z_BAND_MARGIN_MM = 12;

function assertSaneDelta(delta: Vec3) {
	const big = (['x', 'y', 'z'] as const).find((k) => Math.abs(delta[k]) > MAX_NUDGE_MM);
	if (big) {
		throw new Error(
			`Rejected: Δ${big}=${delta[big]}mm exceeds the ${MAX_NUDGE_MM}mm per-edit limit. ` +
				`A correction this large is almost always a bad capture (e.g. a tip on/off frame ` +
				`mismatch). Re-check the tip state and re-capture; type a smaller delta to override intentionally.`
	);
	}
}

function zBand(def: any): { min: number; max: number } | null {
	const zDim = Number(def?.definition?.dimensions?.zDimension ?? 0);
	if (!Number.isFinite(zDim) || zDim <= 0) return null;
	return { min: -Z_BAND_MARGIN_MM, max: zDim + Z_BAND_MARGIN_MM };
}

export async function applyDeckEdit(input: ApplyDeckEditInput): Promise<ApplyDeckEditResult> {
	await connectDB();
	const { deckLoadName, wellName } = input;
	const delta: Vec3 = { x: n(input.delta?.x), y: n(input.delta?.y), z: n(input.delta?.z) };

	const def = (await LabwareDefinition.findOne({ loadName: deckLoadName }).lean()) as any;
	if (!def) throw new Error(`Labware definition "${deckLoadName}" not found in labware_definitions.`);
	const well = def.definition?.wells?.[wellName];
	if (!well) throw new Error(`Well "${wellName}" not found in "${deckLoadName}".`);

	const before: Vec3 = { x: n(well.x), y: n(well.y), z: n(well.z) };
	const after: Vec3 = { x: before.x + delta.x, y: before.y + delta.y, z: before.z + delta.z };

	// Guard against geometry runaway (the 2026-06 deck-004 Z-shift corruption).
	assertSaneDelta(delta);
	const band = zBand(def);
	if (band && (after.z < band.min || after.z > band.max)) {
		throw new Error(
			`Rejected: ${wellName} z would become ${after.z.toFixed(2)}mm, outside the ` +
				`labware's physical band [${band.min}, ${band.max.toFixed(1)}]mm. Likely a bad capture.`
		);
	}

	// 1. Mongo source of truth — set the well's coords (Mixed sub-path).
	await LabwareDefinition.updateOne(
		{ loadName: deckLoadName },
		{
			$set: {
				[`definition.wells.${wellName}.x`]: after.x,
				[`definition.wells.${wellName}.y`]: after.y,
				[`definition.wells.${wellName}.z`]: after.z
			}
		}
	);

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

	// Guard against geometry runaway — one delta hits many wells, so reject the
	// whole batch up front rather than corrupting a cartridge at a time.
	assertSaneDelta(delta);

	const def = (await LabwareDefinition.findOne({ loadName: deckLoadName }).lean()) as any;
	if (!def) throw new Error(`Labware definition "${deckLoadName}" not found in labware_definitions.`);
	const wells = def.definition?.wells ?? {};
	const band = zBand(def);

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
		if (band && (after.z < band.min || after.z > band.max)) {
			failed.push({ wellName, reason: `z ${after.z.toFixed(2)}mm out of band [${band.min}, ${band.max.toFixed(1)}]` });
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

	// 1. One Mongo write for every well's coords.
	await LabwareDefinition.updateOne({ loadName: deckLoadName }, { $set: setOps });

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

/** Recent per-hole edit history for a deck (for the tuner page). */
export async function deckEditHistory(deckLoadName: string, limit = 100) {
	await connectDB();
	return (await DeckCalibrationEdit.find({ deckLoadName })
		.sort({ createdAt: -1 })
		.limit(limit)
		.lean()) as any[];
}
