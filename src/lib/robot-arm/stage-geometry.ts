/**
 * The robot-arm wax-fill STAGE: one Gen7 cartridge on an elevated single-cart
 * platform, located by the taught rim of its FIRST wax hole.
 *
 * This is the TypeScript twin of `stage_targets()` in
 * protocols/Wax_Filling_GEN7_ArmStage.py — same pitch, same names, same fill
 * order, same per-hole corrections — so the Stage Calibration Studio draws
 * and visits exactly the holes the protocol will dispense into. Keep the two
 * in step; the unit tests of both pin the same numbers.
 *
 * Geometry (gen4deck_gen7cartridge_001, BIMS live definition 2026-08-19): the
 * four wax holes of a row (deck columns 2,4,6,8 = gates 4,3,2,1) sit 6.0 mm
 * apart along −x; the three rows (deck rows X,W,V) sit 9.0 mm apart along −y.
 * The reagent hole that pairs with each wax hole (odd column, same row) sits
 * +3.301 mm in x and +2.099 mm in y from it, on a raised boss (drawn only for
 * orientation on the Studio's plane — the wax fill never visits it).
 */

export const STAGE_COLS = ['2', '4', '6', '8'] as const; // gate 4 → gate 1
export const STAGE_ROWS = ['X', 'W', 'V'] as const; // row 1 → row 3
export const COL_PITCH_X = -6.0;
export const ROW_PITCH_Y = -9.0;
export const COLUMN_GATE: Record<string, 4 | 3 | 2 | 1> = { '2': 4, '4': 3, '6': 2, '8': 1 };
/** Fill-order names, X2 … V8. */
export const STAGE_WELL_NAMES: string[] = STAGE_ROWS.flatMap((r) => STAGE_COLS.map((c) => `${r}${c}`));
/** Where the paired reagent hole sits relative to a wax hole (cart frame, before rotation). */
export const REAGENT_HOLE_OFFSET = { dx: 3.301, dy: 2.099 } as const;

/** Wax hole depth on a Gen7 cartridge, mm (the protocol's dispense_depth is measured from the rim). */
export const WAX_HOLE_DEPTH_MM = 3.75;
/** Wax hole bore, mm. */
export const WAX_HOLE_DIAMETER_MM = 1.8;
/** The stage protocol's `dispense_depth` RTP bounds: negative = hover above the rim. */
export const DISPENSE_DEPTH_LIMITS = { min: -2.0, max: 2.5 } as const;
/** The protocol's default when no depth is taught (hover 1 mm above the rim). */
export const DISPENSE_DEPTH_DEFAULT_MM = -1.0;
/** The stage protocol's `stage_jump_height` RTP bounds (travel clearance over the rim). */
export const STAGE_JUMP_LIMITS = { min: 10, max: 60 } as const;
export const STAGE_JUMP_DEFAULT_MM = 60;
/**
 * How the arm's stage holds the cart: turned exactly 90° counter-clockwise (seen
 * from above) from a carriage slot, so the gates run toward the FRONT of the
 * OT-2 — toward the operator — with gate 4 at the back, and the three rows run
 * left → right. This is the default for a calibration that has never set a
 * rotation; a stage that holds the cart the other way round is 270° (−90°).
 */
export const STAGE_ROTATION_DEFAULT_DEG = 90;
/** Pre-jump height the fill pauses at over a hole before descending (protocol constant). */
export const STAGE_PREJUMP_MM = 5;
/** Largest per-hole correction the protocol's hole_NN_dx/dy/dz RTPs accept, mm. */
export const HOLE_OFFSET_LIMIT_MM = 5;

/**
 * Where the taught cart location (the first wax hole, deck mm) may sit: the
 * protocol's arm_cart_x / arm_cart_y / arm_cart_z RTP bounds. A whole-cart shift
 * is a re-teach of that point, so it is bounded by these, not by the per-hole
 * ±HOLE_OFFSET_LIMIT_MM correction cap.
 */
export const CART_LOCATION_LIMITS = { xy: { min: 0, max: 400 }, z: { min: 0, max: 200 } } as const;

export interface HoleOffset {
	dx: number;
	dy: number;
	dz: number;
}
export type HoleOffsets = Record<string, HoleOffset>;

export interface StageHole {
	/** Deck well name cartridge 1 has for this hole on a full deck (X2 … V8). */
	name: string;
	/** 1-based row (1 = the taught row) and the wax gate (4 … 1). */
	row: 1 | 2 | 3;
	gate: 4 | 3 | 2 | 1;
	/** 0-based position in fill order. */
	index: number;
	/** Tip-neutral rim of this hole, deck frame, mm: rigid layout + this hole's correction. */
	x: number;
	y: number;
	z: number;
	/** The rigid (uncorrected) rim, for drawing where the lattice says the hole is. */
	rigid: { x: number; y: number; z: number };
	/** This hole's correction (0,0,0 when none). */
	offset: HoleOffset;
	/** The paired reagent hole's position, drawn for orientation only. */
	reagent: { x: number; y: number };
}

export const ZERO_OFFSET: HoleOffset = { dx: 0, dy: 0, dz: 0 };

/** The protocol's RTP names for a hole's correction (1-based index in fill order). */
export function holeOffsetParamNames(index0: number): { dx: string; dy: string; dz: string } {
	const n = String(index0 + 1).padStart(2, '0');
	return { dx: `hole_${n}_dx`, dy: `hole_${n}_dy`, dz: `hole_${n}_dz` };
}

/**
 * The 12 wax-hole rims of a cartridge whose first hole (row 1, gate 4) has its
 * rim at (x0, y0, z0), turned `rotationDeg` counter-clockwise (seen from above)
 * about that hole, each then moved by its own correction. 0° = as in a carriage
 * slot (gates run toward −x, rows toward −y); 180° = the cart turned end for end.
 * Fill order: row 1 gates 4→1, row 2, row 3.
 */
export function stageTargets(x0: number, y0: number, z0: number, rotationDeg = 0, offsets: HoleOffsets = {}): StageHole[] {
	const th = ((Number(rotationDeg) || 0) * Math.PI) / 180;
	const c = Math.cos(th);
	const s = Math.sin(th);
	const rot = (dx: number, dy: number) => ({ x: dx * c - dy * s, y: dx * s + dy * c });
	const out: StageHole[] = [];
	STAGE_ROWS.forEach((rowName, ri) => {
		STAGE_COLS.forEach((col, ci) => {
			const name = `${rowName}${col}`;
			const r = rot(ci * COL_PITCH_X, ri * ROW_PITCH_Y);
			const rg = rot(ci * COL_PITCH_X + REAGENT_HOLE_OFFSET.dx, ri * ROW_PITCH_Y + REAGENT_HOLE_OFFSET.dy);
			const o = offsets[name] ?? ZERO_OFFSET;
			const rigid = { x: round3(x0 + r.x), y: round3(y0 + r.y), z: z0 };
			out.push({
				name,
				row: (ri + 1) as 1 | 2 | 3,
				gate: COLUMN_GATE[col],
				index: ri * STAGE_COLS.length + ci,
				x: round3(rigid.x + (o.dx || 0)),
				y: round3(rigid.y + (o.dy || 0)),
				z: round3(rigid.z + (o.dz || 0)),
				rigid,
				offset: { dx: o.dx || 0, dy: o.dy || 0, dz: o.dz || 0 },
				reagent: { x: round3(x0 + rg.x), y: round3(y0 + rg.y) }
			});
		});
	});
	return out;
}

/** Absolute Z the tip end dispenses at for a given rim Z and dispense depth (positive = below the rim). */
export function dispenseZ(rimZ: number, depthMm: number | null | undefined): number {
	return round3(rimZ - (depthMm ?? DISPENSE_DEPTH_DEFAULT_MM));
}

/** The dispense depth a live tip-end Z means for a rim at rimZ (positive = below the rim). */
export function depthFromLive(rimZ: number, liveZ: number): number {
	return Math.round((rimZ - liveZ) * 100) / 100;
}

function round3(n: number): number {
	return Math.round(n * 1000) / 1000;
}
