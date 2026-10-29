/**
 * The robot-arm wax-fill STAGE: one Gen7 cartridge on an elevated single-cart
 * platform, located by the taught rim of its FIRST wax hole.
 *
 * This is the TypeScript twin of `stage_targets()` in
 * protocols/Wax_Filling_GEN7_ArmStage.py — same pitch, same names, same fill
 * order — so the Stage calibration page can draw and visit exactly the holes
 * the protocol will dispense into. Keep the two in step; the unit tests of both
 * pin the same numbers.
 *
 * Geometry (gen4deck_gen7cartridge_001, BIMS live definition 2026-08-19): the
 * four wax holes of a row (deck columns 2,4,6,8 = gates 4,3,2,1) sit 6.0 mm
 * apart along −x; the three rows (deck rows X,W,V) sit 9.0 mm apart along −y.
 */

export const STAGE_COLS = ['2', '4', '6', '8'] as const; // gate 4 → gate 1
export const STAGE_ROWS = ['X', 'W', 'V'] as const; // row 1 → row 3
export const COL_PITCH_X = -6.0;
export const ROW_PITCH_Y = -9.0;
export const COLUMN_GATE: Record<string, 4 | 3 | 2 | 1> = { '2': 4, '4': 3, '6': 2, '8': 1 };

/** Wax hole depth on a Gen7 cartridge, mm (the protocol's dispense_depth is measured from the rim). */
export const WAX_HOLE_DEPTH_MM = 3.75;
/** The stage protocol's `dispense_depth` RTP bounds: negative = hover above the rim. */
export const DISPENSE_DEPTH_LIMITS = { min: -2.0, max: 2.5 } as const;
/** The protocol's default when no depth is taught (hover 1 mm above the rim). */
export const DISPENSE_DEPTH_DEFAULT_MM = -1.0;
/**
 * No travel height: on the robot-arm line the pipette goes ALL THE WAY UP (a
 * Z-only home) before every move between stations — tip rack, calibrator,
 * tube, trash, the cart and between its rows. The arm and its stage stand
 * above anything the OT-2's planner knows about, so travel happens at the top
 * of Z and comes straight down at the target. Protocol: lift() in
 * protocols/Wax_Filling_GEN7_ArmStage.py; teach page: lift() before each move.
 */
/** Pre-jump height the fill pauses at over a hole before descending (protocol constant). */
export const STAGE_PREJUMP_MM = 5;

export interface StageHole {
	/** Deck well name cartridge 1 has for this hole on a full deck (X2 … V8). */
	name: string;
	/** 1-based row (1 = the taught row) and the wax gate (4 … 1). */
	row: 1 | 2 | 3;
	gate: 4 | 3 | 2 | 1;
	/** 0-based position in fill order. */
	index: number;
	/** Tip-neutral rim of this hole, deck frame, mm. */
	x: number;
	y: number;
	z: number;
}

/**
 * The 12 wax-hole rims of a cartridge whose first hole (row 1, gate 4) has its
 * rim at (x0, y0, z0), turned `rotationDeg` counter-clockwise (seen from above)
 * about that hole. 0 = as in a carriage slot (gates run toward −x, rows toward
 * −y); 180 = the cart turned end for end. Fill order: row 1 gates 4→1, row 2, row 3.
 */
export function stageTargets(x0: number, y0: number, z0: number, rotationDeg = 0): StageHole[] {
	const th = ((Number(rotationDeg) || 0) * Math.PI) / 180;
	const c = Math.cos(th);
	const s = Math.sin(th);
	const out: StageHole[] = [];
	STAGE_ROWS.forEach((rowName, ri) => {
		STAGE_COLS.forEach((col, ci) => {
			const dx = ci * COL_PITCH_X;
			const dy = ri * ROW_PITCH_Y;
			out.push({
				name: `${rowName}${col}`,
				row: (ri + 1) as 1 | 2 | 3,
				gate: COLUMN_GATE[col],
				index: ri * STAGE_COLS.length + ci,
				x: round3(x0 + dx * c - dy * s),
				y: round3(y0 + dx * s + dy * c),
				z: z0
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
