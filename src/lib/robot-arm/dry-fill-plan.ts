/**
 * Dry Fill All Holes (Stage Calibration, rebuilt 2026-11-06): the stage
 * protocol's fill of ONE cart, step for step, played through the page's Jog
 * (maintenance) run with the tip already on the pipette. The tip is never
 * picked up or dropped here, so the same tip serves as many Dry Fills as the
 * operator wants, and stays on for jogging afterwards.
 *
 * Every number and every move is a port of protocols/Wax_Filling_GEN7_ArmStage.py
 * (fill_cart → aspirate_batch → settle_after_aspirate → dispense_batch →
 * blow_out), with wax = True: the plunger moves as in a real fill, on air.
 * Keep the two in step:
 *   plan_batches        → planBatches        (batches never cross a row)
 *   source_height       → sourceHeight       (the 2 mL tube's volume → height table)
 *   tube_depth_for      → tubeDepthFor       (aspirate depth below the rim, floor clamp)
 *   source_volume       → 50 µL dead volume + one cart's volume, less each batch dispensed
 *
 * Pure on purpose (no robot, no DB) so it is unit tested and the page only plays it.
 */

/** The wax tube: tuberack['A3'] in slot 10 (the protocol's tube_locations['wax']). */
export const DRY_FILL_TUBE = { loadName: 'cosmas_and_damian_drybath_tuberack', slot: '10', well: 'A3' } as const;

/** The protocol's constants. */
const MAX_PER_ASPIRATION_UL = 20; // maximum_volume_per_aspiration
const DEAD_VOLUME_UL = 50;
const ASPIRATE_Z_TWEAK_MM = 0.25; // aspirating_z_height_tweak
const MAX_ASPIRATE_DEPTH_MM = 50 + ASPIRATE_Z_TWEAK_MM;
const ASPIRATE_COVER_MM = 2;
const SETTLE_BELOW_RIM_MM = 2.3; // move_to(top(-2.3)), touch_tip(v_offset=-2.3)
const SETTLE_DELAY_S = 3;
const SETTLE_DRIP_UL = 0.25; // dispense(.25, top(), rate=0.5)
const SETTLE_DRIP_RATE = 0.5;
const ASPIRATE_DELAY_S = 2;
const ARRIVE_DELAY_S = 0.3;
const DISPENSE_RATE = 0.325; // dispense_rates, every gate
/** touch_tip() defaults (API 2.19): radius 1.0 of the well, 60 mm/s. */
const TOUCH_TIP_RADIUS = 1;
const TOUCH_TIP_SPEED = 60;
/**
 * p20_single_gen2 default flow rates at the protocol's apiLevel 2.19 (shared-data
 * pipette definition, 7.56 µL/s from API 2.6 on). `rate=` in the protocol scales these.
 */
export const P20_DEFAULT_FLOW_UL_S = 7.56;

/** The 2 mL tube's liquid height (mm above the bottom) per volume (µL) — the protocol's lookup_table_2mL. */
const TUBE_2ML_HEIGHTS: [number, number][] = [
	[50, 3.8], [100, 4.15], [150, 5.65], [200, 6.57], [300, 7.71], [400, 9.9],
	[500, 11.1], [750, 15.01], [1000, 19.12], [1500, 26.33], [2000, 33.6], [2250, 37.06]
];

export interface DryFillHole {
	name: string;
	/** Wax gate 4 … 1 (the hole's column). */
	gate: 1 | 2 | 3 | 4;
}

export interface DryFillInput {
	/** The holes in fill order (row 1 gates 4→1, row 2, row 3). */
	holes: DryFillHole[];
	/** vol_gate1 … vol_gate4, µL. */
	gateVolumes: Record<1 | 2 | 3 | 4, number>;
	/** aspirate_remainder, µL. */
	aspirateRemainder: number;
	/** min_tip_clearance: the aspirate floor above the tube bottom, mm. */
	minTipClearanceMm: number;
	/** The wax tube's depth, rim to bottom, mm (the labware definition's A3 depth). */
	tubeDepthMm: number;
}

/** One step, in order. The page plays them through the Jog run. */
export type DryFillStep =
	/** ALL THE WAY UP: the Z-only home (lift()). */
	| { op: 'lift' }
	/** To the wax tube, `belowRimMm` below its rim (0 = the top); planned, as the protocol's source_well.top(…). */
	| { op: 'tube'; belowRimMm: number }
	/** The plunger to its aspirate start, in place (what aspirate() does first after a blow-out). */
	| { op: 'prepare' }
	| { op: 'aspirate'; volume: number; flowRate: number }
	| { op: 'dispense'; volume: number; flowRate: number }
	| { op: 'blowOut'; flowRate: number }
	| { op: 'touchTip'; belowRimMm: number; radius: number; speed: number }
	| { op: 'delay'; seconds: number }
	/**
	 * Over a hole: `at` prejump = STAGE_PREJUMP_MM above its rim, dispense = the
	 * taught dispense height; `planned` = a planned move (after a lift), else a
	 * straight line. The page adds the tip's probe adjust, as the protocol does.
	 */
	| { op: 'hole'; name: string; at: 'prejump' | 'dispense'; planned: boolean };

export interface DryFillBatch {
	holes: { name: string; volume: number }[];
	/** Batch + remainder, µL. */
	aspirateVolume: number;
	/** How far below the tube rim the tip end aspirates, mm. */
	aspirateBelowRimMm: number;
}

export interface DryFillPlan {
	batches: DryFillBatch[];
	steps: DryFillStep[];
	/** What one cart takes, µL. */
	cartVolume: number;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

function rowOf(name: string): string {
	return name.replace(/\d+$/, '');
}

/** Python's bisect_left over the table's volumes. */
function bisectLeft(v: number): number {
	let i = 0;
	while (i < TUBE_2ML_HEIGHTS.length && TUBE_2ML_HEIGHTS[i][0] < v) i++;
	return i;
}

/** source_height − tube bottom: the liquid height (mm) for `volume` µL, interpolated exactly as the protocol does. */
export function liquidHeight(volume: number): number {
	const i = bisectLeft(volume);
	if (i + 1 >= TUBE_2ML_HEIGHTS.length) throw new Error(`Dry Fill: ${volume} µL is past the 2 mL tube table.`);
	const [v0, h0] = TUBE_2ML_HEIGHTS[i];
	const [v1, h1] = TUBE_2ML_HEIGHTS[i + 1];
	return h0 + (h1 - h0) * ((volume - v0) / (v1 - v0));
}

/** tube_depth_for: how far below the rim the tip end sits to aspirate, clamped to the floor. Null = too deep. */
export function tubeDepthFor(input: Pick<DryFillInput, 'tubeDepthMm' | 'minTipClearanceMm'>, sourceVolume: number, aspirateVolume: number): number | null {
	const aspirateEnd = input.tubeDepthMm - liquidHeight(sourceVolume - aspirateVolume);
	if (aspirateEnd + ASPIRATE_COVER_MM > MAX_ASPIRATE_DEPTH_MM) return null;
	const floorBelowRim = input.tubeDepthMm - input.minTipClearanceMm;
	return r3(Math.min(aspirateEnd + ASPIRATE_COVER_MM, floorBelowRim));
}

/** plan_batches: in fill order, never past the usable volume per trip, never across a row. */
export function planBatches(input: DryFillInput): { name: string; volume: number }[][] {
	const available = MAX_PER_ASPIRATION_UL - input.aspirateRemainder;
	const batches: { name: string; volume: number }[][] = [];
	let i = 0;
	while (i < input.holes.length) {
		const batch: { name: string; volume: number }[] = [];
		let total = 0;
		for (let j = i; j < input.holes.length; j++) {
			const h = input.holes[j];
			const vol = input.gateVolumes[h.gate];
			if (total + vol > available + 1e-9) break;
			if (batch.length > 0 && rowOf(h.name) !== rowOf(input.holes[i].name)) break;
			batch.push({ name: h.name, volume: vol });
			total += vol;
		}
		if (!batch.length) {
			throw new Error(`Dry Fill: hole ${input.holes[i].name} needs more than the ${r3(available)} µL usable per aspiration. Lower its gate volume or the aspirate remainder.`);
		}
		batches.push(batch);
		i += batch.length;
	}
	return batches;
}

/** The whole Dry Fill of one cart: every batch, in the protocol's order. */
export function planDryFill(input: DryFillInput): DryFillPlan {
	if (!input.holes.length) throw new Error('Dry Fill: no holes to fill.');
	const holeBatches = planBatches(input);
	const cartVolume = r3(input.holes.reduce((s, h) => s + input.gateVolumes[h.gate], 0));
	let sourceVolume = DEAD_VOLUME_UL + cartVolume; // cartridges = 1
	const flow = P20_DEFAULT_FLOW_UL_S;
	const steps: DryFillStep[] = [];
	const batches: DryFillBatch[] = [];

	for (const holes of holeBatches) {
		const batchVolume = holes.reduce((s, h) => s + h.volume, 0);
		const aspirateVolume = r3(batchVolume + input.aspirateRemainder);
		const belowRim = tubeDepthFor(input, sourceVolume, aspirateVolume);
		if (belowRim === null) throw new Error('Dry Fill: the wax tube model says the aspirate is too deep.');
		batches.push({ holes, aspirateVolume, aspirateBelowRimMm: belowRim });

		// aspirate_batch: all the way up, to the tube top, plunger ready, down, aspirate, 2 s.
		steps.push({ op: 'lift' }, { op: 'tube', belowRimMm: 0 }, { op: 'prepare' });
		steps.push({ op: 'tube', belowRimMm: belowRim }, { op: 'aspirate', volume: aspirateVolume, flowRate: flow });
		steps.push({ op: 'delay', seconds: ASPIRATE_DELAY_S });
		// settle_after_aspirate: up to 2.3 mm below the rim, 3 s, touch tip, drip 0.25 µL back at the top.
		steps.push({ op: 'tube', belowRimMm: SETTLE_BELOW_RIM_MM }, { op: 'delay', seconds: SETTLE_DELAY_S });
		steps.push({ op: 'touchTip', belowRimMm: SETTLE_BELOW_RIM_MM, radius: TOUCH_TIP_RADIUS, speed: TOUCH_TIP_SPEED });
		steps.push({ op: 'tube', belowRimMm: 0 }, { op: 'dispense', volume: SETTLE_DRIP_UL, flowRate: r3(flow * SETTLE_DRIP_RATE) });

		// dispense_batch: a batch is one row, so only its first hole is arrived at from the top.
		holes.forEach((h, k) => {
			if (k === 0) {
				steps.push({ op: 'lift' }, { op: 'hole', name: h.name, at: 'prejump', planned: true }, { op: 'delay', seconds: ARRIVE_DELAY_S });
			} else {
				steps.push({ op: 'hole', name: h.name, at: 'prejump', planned: false });
			}
			steps.push({ op: 'hole', name: h.name, at: 'dispense', planned: false });
			steps.push({ op: 'dispense', volume: h.volume, flowRate: r3(flow * DISPENSE_RATE) });
		});
		sourceVolume -= batchVolume;

		// leave, then blow_out(location=source_well.top()).
		steps.push({ op: 'lift' }, { op: 'tube', belowRimMm: 0 }, { op: 'blowOut', flowRate: flow });
	}
	// The run would park in the wax here; the Dry Fill ends all the way up with the tip still on.
	steps.push({ op: 'lift' });
	return { batches, steps, cartVolume };
}
