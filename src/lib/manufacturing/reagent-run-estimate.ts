/**
 * Reagent-fill duration estimate.
 *
 * The old estimate was `cartridgeCount × fillTimePerCartridgeMin`, which ignored
 * how many reagent rows the operator actually selected. With the shipped setting
 * of 2 min/cartridge a 24-cartridge run predicted 48 minutes; the same run
 * measured 22-25 minutes on the robot, so the countdown was roughly 2x reality.
 *
 * What actually drives the run time is the number of DISPENSES, which comes from
 * the well_* run-time parameters, not the cartridge count alone:
 *
 *   - well_2 / well_3 / well_4 / well_5   fill a whole reagent row  -> 3 wells per cartridge
 *   - well_2a…well_5c (sub-rows)          fill one column of a row  -> 1 well per cartridge
 *
 * Each selected group is one `dispense_reagent(...)` call in
 * `protocols/Reagent_Filling_GEN7.py`: pick up a tip, calibrate it, aspirate in
 * batches, dispense into every well, drop the tip. So:
 *
 *   seconds = startupOverheadSec
 *           + reagentGroups × secondsPerReagentGroup
 *           + dispenses     × secondsPerDispense
 *
 * The defaults below were fitted against the fastest observed run for each
 * distinct (dispenses, groups) shape in `reagent_batch_records` — the fastest
 * run of a shape is the one with the least operator dwell, so it is closest to
 * robot-only time. Predicted vs. measured on that set: 288 dispenses 22.8 vs
 * 22.0 min, 264 -> 21.3 vs 21.0, 207 -> 16.8 vs 17.3, 192 -> 16.8 vs 16.5,
 * 180 -> 16.1 vs 15.4.
 *
 * All three constants are overridable from Manufacturing Settings so the fit can
 * be re-tuned from the UI as the protocol changes, without a deploy.
 */

/** Reagent rows that fill every well in the row — 3 wells per cartridge. */
const FULL_ROW_PARAMS = ['well_2', 'well_3', 'well_4', 'well_5'] as const;

/** Sub-row selections (one column of a row) — 1 well per cartridge. */
const SUB_ROW_PARAMS = [
	'well_2a', 'well_2b', 'well_2c',
	'well_3a', 'well_3b', 'well_3c',
	'well_4a', 'well_4b', 'well_4c',
	'well_5a', 'well_5b', 'well_5c'
] as const;

export interface ReagentRunTuning {
	/** Homing, deck moves and the initial off-deck pause before the first fill. */
	startupOverheadSec: number;
	/** Tip pick-up, tip calibration and source-tube travel, per reagent row. */
	secondsPerReagentGroup: number;
	/** One well: jump move, dispense, retract, settle delay. */
	secondsPerDispense: number;
}

export const DEFAULT_REAGENT_RUN_TUNING: ReagentRunTuning = {
	startupOverheadSec: 60,
	secondsPerReagentGroup: 60,
	secondsPerDispense: 3.7
};

export interface ReagentRunEstimate {
	/** Estimated wall-clock duration, robot-only (excludes operator dwell). */
	seconds: number;
	/** Number of `dispense_reagent` calls — one per selected reagent row. */
	reagentGroups: number;
	/** Total wells the protocol will fill. */
	dispenses: number;
	/**
	 * True when the estimate had nothing to go on (no well_* parameters present,
	 * e.g. a run recorded before the parameters were captured). Callers should
	 * treat the number as a rough floor rather than an estimate.
	 */
	fellBackToCartridgeCount: boolean;
	/**
	 * True when `run_calibration_check` is on. That routine ends in an operator
	 * `protocol.pause(...)` of unbounded length, so the estimate cannot cover it.
	 */
	hasOperatorPause: boolean;
}

/**
 * Count the wells the protocol will fill, from the run-time parameters the
 * operator submitted. Mirrors `dispense_reagent`'s
 * `wells_to_fill = wells[0 : cartridges × wells_on_cart]`.
 */
export function countReagentWork(
	protocolParameters: Record<string, unknown> | null | undefined,
	cartridgeCount: number
): { reagentGroups: number; dispenses: number; sawWellParams: boolean } {
	const params = protocolParameters ?? {};
	const carts = Math.max(0, cartridgeCount || 0);

	let reagentGroups = 0;
	let dispenses = 0;
	let sawWellParams = false;

	for (const key of FULL_ROW_PARAMS) {
		if (key in params) sawWellParams = true;
		if (params[key] === true) {
			reagentGroups += 1;
			dispenses += carts * 3;
		}
	}
	for (const key of SUB_ROW_PARAMS) {
		if (key in params) sawWellParams = true;
		if (params[key] === true) {
			reagentGroups += 1;
			dispenses += carts * 1;
		}
	}

	return { reagentGroups, dispenses, sawWellParams };
}

/**
 * Estimate how long a reagent fill will take.
 *
 * `tuning` values that are missing or non-finite fall back to the defaults, so a
 * partially-populated ManufacturingSettings document can be passed straight in.
 */
export function estimateReagentRunSeconds(
	protocolParameters: Record<string, unknown> | null | undefined,
	cartridgeCount: number,
	tuning?: Partial<ReagentRunTuning> | null
): ReagentRunEstimate {
	const t = resolveTuning(tuning);
	const { reagentGroups, dispenses, sawWellParams } = countReagentWork(protocolParameters, cartridgeCount);
	const hasOperatorPause = (protocolParameters ?? {})['run_calibration_check'] === true;

	// No well_* parameters at all: nothing to model. Assume all four full rows,
	// which is what the line runs by default, rather than returning zero.
	if (!sawWellParams || dispenses === 0) {
		const assumedGroups = FULL_ROW_PARAMS.length;
		const assumedDispenses = Math.max(0, cartridgeCount || 0) * 3 * assumedGroups;
		return {
			seconds: Math.round(
				t.startupOverheadSec
					+ assumedGroups * t.secondsPerReagentGroup
					+ assumedDispenses * t.secondsPerDispense
			),
			reagentGroups: assumedGroups,
			dispenses: assumedDispenses,
			fellBackToCartridgeCount: true,
			hasOperatorPause
		};
	}

	return {
		seconds: Math.round(
			t.startupOverheadSec
				+ reagentGroups * t.secondsPerReagentGroup
				+ dispenses * t.secondsPerDispense
		),
		reagentGroups,
		dispenses,
		fellBackToCartridgeCount: false,
		hasOperatorPause
	};
}

function resolveTuning(tuning?: Partial<ReagentRunTuning> | null): ReagentRunTuning {
	const pick = (v: unknown, fallback: number) =>
		typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
	return {
		startupOverheadSec: pick(tuning?.startupOverheadSec, DEFAULT_REAGENT_RUN_TUNING.startupOverheadSec),
		secondsPerReagentGroup: pick(tuning?.secondsPerReagentGroup, DEFAULT_REAGENT_RUN_TUNING.secondsPerReagentGroup),
		secondsPerDispense: pick(tuning?.secondsPerDispense, DEFAULT_REAGENT_RUN_TUNING.secondsPerDispense)
	};
}
