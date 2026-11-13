/**
 * DILUENT-FILL-1 S5 — labware offsets from the BIMS Labware Position Check,
 * kept per robot in `robot_labware_offsets` (the CALIB-5 store, source 'lpc')
 * and handed to the robot at run creation as run-level `labwareOffsets`.
 *
 * The clone's LPC wizard used to keep its result only in the browser tab
 * (sessionStorage → the clone's own run create); a manufacturing start never
 * saw it. Now the wizard also POSTs here, and a DILUENT start reads the rows
 * for the labware its protocol analysis lists (definition URI × slot) and
 * sends them with POST /runs. Wax/reagent starts do NOT: their .py apply the
 * slot 10/11 rack offsets through RTPs (set_offset), and a run-level entry on
 * top would double them.
 */
import { connectDB, RobotLabwareOffset, AuditLog, generateId } from '$lib/server/db';
import { checkRackOffset, type Vec3 } from '$lib/server/services/deck-calibration/rack-offsets';
import type { LegacyLabwareOffset } from '$lib/opentrons/ot2-protocol';

const HISTORY_MAX = 10;
const OT2_SLOTS = new Set(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11']);
const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : NaN);

/** One labware as the robot's protocol analysis lists it (`analysis.labware[]`). */
export interface AnalysisLabwareLike {
	loadName?: string | null;
	displayName?: string | null;
	definitionUri?: string | null;
	location?: { slotName?: string | null } | null;
}

export interface StoredOffsetRow {
	definitionUri: string;
	loadName: string;
	slotName: string;
	vector: Vec3;
	taughtAt: string | null;
	taughtBy: string | null;
	source: string;
}

export interface LpcOffsetInput {
	definitionUri: string;
	loadName: string;
	displayName?: string | null;
	slotName: string;
	vector: Vec3;
}

/** Validate one offset the wizard posted; returns the problem or null. */
export function checkLpcOffset(o: any): string | null {
	if (typeof o?.definitionUri !== 'string' || !/^[^/]+\/[^/]+\/\d+$/.test(o.definitionUri)) return 'definitionUri must be namespace/loadName/version';
	if (typeof o?.loadName !== 'string' || !o.loadName) return 'loadName is required';
	if (typeof o?.slotName !== 'string' || !OT2_SLOTS.has(o.slotName)) return 'slotName must be an OT-2 slot 1–11';
	const v = { x: num(o?.vector?.x), y: num(o?.vector?.y), z: num(o?.vector?.z) };
	if ([v.x, v.y, v.z].some((n) => Number.isNaN(n))) return 'vector.x/y/z must be numbers';
	const bad = checkRackOffset(v);
	if (bad) return bad;
	return null;
}

/** Slot-based, non-tiprack labware of an analysis — what the LPC measures. */
export function lpcTargets(analysisLabware: unknown): Array<{ definitionUri: string; loadName: string; slotName: string }> {
	if (!Array.isArray(analysisLabware)) return [];
	const out: Array<{ definitionUri: string; loadName: string; slotName: string }> = [];
	for (const lw of analysisLabware as AnalysisLabwareLike[]) {
		const uri = lw?.definitionUri;
		const slot = lw?.location?.slotName;
		if (typeof uri !== 'string' || !uri || typeof slot !== 'string' || !slot) continue;
		if (/tiprack/i.test(String(lw.loadName ?? ''))) continue;
		out.push({ definitionUri: uri, loadName: String(lw.loadName ?? uri.split('/')[1] ?? ''), slotName: slot });
	}
	return out;
}

/**
 * The run-level offsets for an analysis's labware: one per labware that has a
 * stored row for its definition URI in its slot. Zero vectors are left out
 * (nothing to apply). Pure, so the start path and the wizard agree.
 */
export function legacyOffsetsFor(
	rows: Array<{ definitionUri: string; slotName: string; vector: Vec3 }>,
	analysisLabware: unknown
): LegacyLabwareOffset[] {
	if (!Array.isArray(analysisLabware)) return [];
	const out: LegacyLabwareOffset[] = [];
	const seen = new Set<string>();
	for (const lw of analysisLabware as AnalysisLabwareLike[]) {
		const uri = lw?.definitionUri;
		const slot = lw?.location?.slotName;
		if (typeof uri !== 'string' || !uri || typeof slot !== 'string' || !slot) continue;
		const key = `${uri}@${slot}`;
		if (seen.has(key)) continue;
		const row = rows.find((r) => r.definitionUri === uri && r.slotName === slot);
		if (!row) continue;
		const v = { x: num(row.vector?.x) || 0, y: num(row.vector?.y) || 0, z: num(row.vector?.z) || 0 };
		if (v.x === 0 && v.y === 0 && v.z === 0) continue;
		seen.add(key);
		out.push({ definitionUri: uri, location: { slotName: slot }, vector: v });
	}
	return out;
}

const rowOf = (d: any): StoredOffsetRow => ({
	definitionUri: String(d.definitionUri),
	loadName: String(d.loadName ?? ''),
	slotName: String(d.slotName),
	vector: { x: num(d.vector?.x) || 0, y: num(d.vector?.y) || 0, z: num(d.vector?.z) || 0 },
	taughtAt: d.taughtAt ? new Date(d.taughtAt).toISOString() : null,
	taughtBy: d.taughtBy?.username ?? null,
	source: String(d.source ?? 'studio')
});

/** Every stored offset row for this robot (any source, any slot). */
export async function listStoredOffsets(robotId: string): Promise<StoredOffsetRow[]> {
	await connectDB();
	const docs = await RobotLabwareOffset.find({ robotId: String(robotId) }).lean();
	return (docs as any[]).map(rowOf);
}

/** The run-level offsets a start should send for this robot + this analysis's labware. */
export async function storedOffsetsForLabware(robotId: string, analysisLabware: unknown): Promise<LegacyLabwareOffset[]> {
	if (!robotId || !Array.isArray(analysisLabware) || !analysisLabware.length) return [];
	return legacyOffsetsFor(await listStoredOffsets(robotId), analysisLabware);
}

/**
 * Upsert the offsets a Labware Position Check measured on this robot, one row
 * per definition URI × slot, the replaced vector on top of `history`, one
 * AuditLog row for the batch.
 */
export async function saveLpcOffsets(input: {
	robotId: string;
	protocolId?: string | null;
	offsets: LpcOffsetInput[];
	user: { _id?: string; username?: string };
}): Promise<{ saved: number; rows: StoredOffsetRow[] }> {
	await connectDB();
	const now = new Date();
	const results: Array<{ definitionUri: string; slotName: string; before: Vec3; after: Vec3 }> = [];
	for (const o of input.offsets) {
		const bad = checkLpcOffset(o);
		if (bad) throw new Error(`Offset for ${o?.loadName ?? o?.definitionUri ?? '?'} in slot ${o?.slotName ?? '?'}: ${bad}`);
		const selector = { robotId: String(input.robotId), definitionUri: o.definitionUri, slotName: o.slotName };
		const prev = (await RobotLabwareOffset.findOne(selector).lean()) as any;
		const before: Vec3 = prev ? { x: num(prev.vector?.x) || 0, y: num(prev.vector?.y) || 0, z: num(prev.vector?.z) || 0 } : { x: 0, y: 0, z: 0 };
		const after: Vec3 = { x: num(o.vector.x), y: num(o.vector.y), z: num(o.vector.z) };
		const note = `Labware Position Check${input.protocolId ? ` on protocol ${input.protocolId}` : ''}`;
		const update: any = {
			$set: { loadName: o.loadName, vector: after, taughtBy: { _id: input.user?._id, username: input.user?.username }, taughtAt: now, source: 'lpc', note },
			$setOnInsert: { _id: generateId() }
		};
		if (prev) {
			update.$push = {
				history: {
					$each: [{ vector: before, taughtBy: prev.taughtBy ?? null, taughtAt: prev.taughtAt ?? null, source: prev.source ?? 'studio', note: prev.note ?? null }],
					$position: 0,
					$slice: HISTORY_MAX
				}
			};
		}
		await RobotLabwareOffset.updateOne(selector, update, { upsert: true });
		results.push({ definitionUri: o.definitionUri, slotName: o.slotName, before, after });
	}
	if (results.length) {
		await AuditLog.create({
			_id: generateId(),
			tableName: 'robot_labware_offsets',
			recordId: String(input.robotId),
			action: 'save_lpc_offsets',
			newData: { robotId: input.robotId, protocolId: input.protocolId ?? null, offsets: results },
			changedAt: now,
			changedBy: input.user?.username
		});
	}
	return { saved: results.length, rows: await listStoredOffsets(input.robotId) };
}
