/**
 * CALIB-5 — per-robot offsets for the two rack slots (10 tube rack, 11 tip rack).
 *
 * ONE place that answers "where does THIS robot's rack sit relative to the shared
 * definition?". Two consumers, same vector:
 *
 *   fill run   → rackOffsetRtpValues(): the vector becomes `tiprack_offset_*` /
 *                `tuberack_offset_*` run-time parameters, which the .py passes to
 *                Labware.set_offset(). (A run-level labwareOffsets entry in POST
 *                /runs would be overridden by the .py's own set_offset call on
 *                API 2.18+, so the .py has to be the applier.)
 *   Studio     → getRackOffset(): the same vector is registered on the
 *                maintenance run (POST /maintenance_runs/{id}/labware_offsets)
 *                before the rack is loaded, so Move-to-hole and Pick-up land
 *                where the fill will.
 *
 * Writes go through saveRackOffset / revertRackOffset only: upsert, capped
 * history, one AuditLog row. The shared definition is never touched here.
 */
import { connectDB, RobotLabwareOffset, AuditLog, generateId } from '$lib/server/db';
import { resolveLabwareDefinition } from './resolve';

export type RackSlot = '10' | '11';
export interface Vec3 {
	x: number;
	y: number;
	z: number;
}
export interface AppliedRackOffset {
	loadName: string;
	definitionUri: string;
	slotName: RackSlot;
	vector: Vec3;
}

/** RTP names the .py declares per slot (CALIB-5 S2). */
export const RACK_RTP: Record<RackSlot, { x: string; y: string; z: string }> = {
	'10': { x: 'tuberack_offset_x', y: 'tuberack_offset_y', z: 'tuberack_offset_z' },
	'11': { x: 'tiprack_offset_x', y: 'tiprack_offset_y', z: 'tiprack_offset_z' }
};

/** Racks the Studio may teach per robot, by slot. Mirrors TUBE_RACKS / TIP_RACKS on the Studio page. */
export const RACK_SLOT_FOR_LOAD_NAME: Record<string, RackSlot> = {
	cosmas_and_damian_drybath_tuberack: '10',
	custom_2ml_24_tube_rack: '10',
	cosmasanddamian_96_tiprack_20ul: '11',
	cosmas_and_damian_biotix_96_200ul_tiprack: '11'
};

/**
 * Largest per-axis offset a rack may carry, in mm. A rack that is further off
 * than this is not "slightly differently seated" — it is in the wrong place, and
 * the fix is physical. Refuse rather than clamp, so a typo cannot drive a
 * pick-up into the rack body.
 */
export const RACK_OFFSET_LIMIT_MM = 10;

export const ZERO: Vec3 = { x: 0, y: 0, z: 0 };
const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const toVec = (v: any): Vec3 => ({ x: n(v?.x), y: n(v?.y), z: n(v?.z) });
const add = (a: Vec3, b: Vec3): Vec3 => ({ x: +(a.x + b.x).toFixed(3), y: +(a.y + b.y).toFixed(3), z: +(a.z + b.z).toFixed(3) });
export const isZero = (v: Vec3) => v.x === 0 && v.y === 0 && v.z === 0;

export function checkRackOffset(v: Vec3): string | null {
	for (const k of ['x', 'y', 'z'] as const) {
		if (!Number.isFinite(v[k])) return `${k} is not a number`;
		if (Math.abs(v[k]) > RACK_OFFSET_LIMIT_MM) return `${k} offset ${v[k]} mm is outside ±${RACK_OFFSET_LIMIT_MM} mm — re-seat the rack instead`;
	}
	return null;
}

export function rackSlotFor(loadName: string): RackSlot | null {
	return RACK_SLOT_FOR_LOAD_NAME[loadName] ?? null;
}

const HISTORY_MAX = 10;

export interface RackOffsetRow {
	_id: string;
	robotId: string;
	loadName: string;
	definitionUri: string;
	slotName: RackSlot;
	vector: Vec3;
	taughtBy: { _id?: string; username?: string } | null;
	taughtAt: Date | null;
	source: string;
	note: string | null;
	historyCount: number;
}

function rowOf(doc: any): RackOffsetRow {
	return {
		_id: String(doc._id),
		robotId: String(doc.robotId),
		loadName: String(doc.loadName),
		definitionUri: String(doc.definitionUri),
		slotName: String(doc.slotName) as RackSlot,
		vector: toVec(doc.vector),
		taughtBy: doc.taughtBy ?? null,
		taughtAt: doc.taughtAt ?? null,
		source: String(doc.source ?? 'studio'),
		note: doc.note ?? null,
		historyCount: Array.isArray(doc.history) ? doc.history.length : 0
	};
}

/** This robot's offset for one rack (by definition URI), or null when it was never taught (= zero). */
export async function getRackOffset(robotId: string, definitionUri: string, slotName: RackSlot): Promise<RackOffsetRow | null> {
	await connectDB();
	const doc = await RobotLabwareOffset.findOne({ robotId: String(robotId), definitionUri: String(definitionUri), slotName }).lean();
	return doc ? rowOf(doc) : null;
}

/** Resolve the load name to its current definition URI, then read the offset. */
export async function getRackOffsetByLoadName(robotId: string, loadName: string): Promise<{ uri: string; slotName: RackSlot; row: RackOffsetRow | null } | null> {
	const slotName = rackSlotFor(loadName);
	if (!slotName) return null;
	const { uri } = await resolveLabwareDefinition(loadName, { strict: true });
	return { uri, slotName, row: await getRackOffset(robotId, uri, slotName) };
}

export async function listRackOffsets(robotId: string): Promise<RackOffsetRow[]> {
	await connectDB();
	const docs = await RobotLabwareOffset.find({ robotId: String(robotId) }).sort({ slotName: 1, loadName: 1 }).lean();
	return docs.map(rowOf);
}

export interface SaveRackOffsetInput {
	robotId: string;
	loadName: string;
	/** Absolute vector to store; or pass `delta` to add to the current vector. */
	vector?: Vec3;
	delta?: Vec3;
	user: { _id?: string; username?: string };
	source?: 'studio' | 'migration' | 'manual';
	note?: string | null;
}

export interface SaveRackOffsetResult {
	robotId: string;
	loadName: string;
	definitionUri: string;
	slotName: RackSlot;
	before: Vec3;
	after: Vec3;
}

/**
 * Upsert this robot's offset for a rack. `delta` is the Studio's captured
 * jog (added to whatever is stored); `vector` is an absolute set (migration,
 * manual). The replaced vector goes to the top of `history`, capped.
 */
export async function saveRackOffset(input: SaveRackOffsetInput): Promise<SaveRackOffsetResult> {
	await connectDB();
	const slotName = rackSlotFor(input.loadName);
	if (!slotName) throw new Error(`"${input.loadName}" is not a rack the Studio can offset per robot (slot 10/11 racks only).`);
	const { uri } = await resolveLabwareDefinition(input.loadName, { strict: true });
	const selector = { robotId: String(input.robotId), definitionUri: uri, slotName };
	const prev = (await RobotLabwareOffset.findOne(selector).lean()) as any;
	const before = prev ? toVec(prev.vector) : { ...ZERO };
	const after = input.vector ? toVec(input.vector) : add(before, toVec(input.delta ?? ZERO));
	const bad = checkRackOffset(after);
	if (bad) throw new Error(`Rack offset for ${input.loadName} on this robot: ${bad}`);

	const now = new Date();
	const update: any = {
		$set: {
			loadName: input.loadName,
			vector: after,
			taughtBy: { _id: input.user?._id, username: input.user?.username },
			taughtAt: now,
			source: input.source ?? 'studio',
			note: input.note ?? null
		},
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
	await AuditLog.create({
		_id: generateId(),
		tableName: 'robot_labware_offsets',
		recordId: `${input.robotId}:${slotName}:${input.loadName}`,
		action: 'save_rack_offset',
		newData: { robotId: input.robotId, loadName: input.loadName, definitionUri: uri, slotName, before, after, delta: input.delta ?? null, source: input.source ?? 'studio', note: input.note ?? null },
		changedAt: now,
		changedBy: input.user?.username
	});
	return { robotId: String(input.robotId), loadName: input.loadName, definitionUri: uri, slotName, before, after };
}

/** Put back the vector this robot's rack had before the last save. */
export async function revertRackOffset(input: { robotId: string; loadName: string; user: { _id?: string; username?: string } }): Promise<SaveRackOffsetResult> {
	await connectDB();
	const slotName = rackSlotFor(input.loadName);
	if (!slotName) throw new Error(`"${input.loadName}" is not a per-robot rack.`);
	const { uri } = await resolveLabwareDefinition(input.loadName, { strict: true });
	const selector = { robotId: String(input.robotId), definitionUri: uri, slotName };
	const prev = (await RobotLabwareOffset.findOne(selector).lean()) as any;
	if (!prev) throw new Error('No offset saved for this rack on this robot — nothing to revert.');
	const hist = Array.isArray(prev.history) ? prev.history : [];
	const before = toVec(prev.vector);
	const after = hist.length ? toVec(hist[0].vector) : { ...ZERO };
	const now = new Date();
	await RobotLabwareOffset.updateOne(selector, {
		$set: { vector: after, taughtBy: { _id: input.user?._id, username: input.user?.username }, taughtAt: now, source: 'revert', note: hist.length ? hist[0].note ?? null : 'reverted to zero' },
		...(hist.length ? { $pop: { history: -1 } } : {})
	});
	await AuditLog.create({
		_id: generateId(),
		tableName: 'robot_labware_offsets',
		recordId: `${input.robotId}:${slotName}:${input.loadName}`,
		action: 'revert_rack_offset',
		newData: { robotId: input.robotId, loadName: input.loadName, definitionUri: uri, slotName, before, after },
		changedAt: now,
		changedBy: input.user?.username
	});
	return { robotId: String(input.robotId), loadName: input.loadName, definitionUri: uri, slotName, before, after };
}

type ParamDef = { variableName: string; min?: number; max?: number };

/**
 * The rack-offset RTPs a fill start injects, for the racks this run will load.
 *
 * `loadNames` says which rack goes in which slot for THIS run (the reagent .py
 * chooses its tube rack at run time, so the caller decides). Only RTPs the
 * uploaded protocol declares are returned — a pre-CALIB-5 .py gets nothing, and
 * a declared RTP always gets an explicit value (0 when the robot has no row) so
 * the run record states what was applied. Values are clamped to the declared
 * range the way max_tip_adjust is.
 */
export async function rackOffsetRtpValues(
	robotId: string,
	paramSchema: ParamDef[],
	loadNames: Partial<Record<RackSlot, string>>
): Promise<{ rtp: Record<string, number>; applied: AppliedRackOffset[] }> {
	const declared = new Map((paramSchema ?? []).map((p) => [p.variableName, p]));
	const rtp: Record<string, number> = {};
	const applied: AppliedRackOffset[] = [];
	for (const slotName of ['10', '11'] as RackSlot[]) {
		const loadName = loadNames[slotName];
		const names = RACK_RTP[slotName];
		if (!loadName || !declared.has(names.x) || !declared.has(names.y) || !declared.has(names.z)) continue;
		let uri: string;
		try {
			uri = (await resolveLabwareDefinition(loadName, { strict: true })).uri;
		} catch (e) {
			console.warn(`[rack-offsets] ${loadName}: ${e instanceof Error ? e.message : e} — sending 0 offset`);
			uri = loadName;
		}
		const row = uri === loadName ? null : await getRackOffset(robotId, uri, slotName);
		const v = row ? row.vector : { ...ZERO };
		for (const k of ['x', 'y', 'z'] as const) {
			const spec = declared.get(names[k])!;
			let val = v[k];
			if (Number.isFinite(Number(spec.max))) val = Math.min(val, Number(spec.max));
			if (Number.isFinite(Number(spec.min))) val = Math.max(val, Number(spec.min));
			rtp[names[k]] = val;
		}
		applied.push({ loadName, definitionUri: uri, slotName, vector: { x: rtp[names.x], y: rtp[names.y], z: rtp[names.z] } });
	}
	return { rtp, applied };
}
