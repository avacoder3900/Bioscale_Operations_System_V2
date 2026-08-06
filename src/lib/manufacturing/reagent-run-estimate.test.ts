import { describe, it, expect } from 'vitest';
import {
	countReagentWork,
	estimateReagentRunSeconds,
	DEFAULT_REAGENT_RUN_TUNING
} from './reagent-run-estimate';

const ALL_FOUR_ROWS = { well_2: true, well_3: true, well_4: true, well_5: true };

describe('countReagentWork', () => {
	it('counts a full reagent row as 3 wells per cartridge', () => {
		expect(countReagentWork({ well_2: true }, 24)).toEqual({
			reagentGroups: 1,
			dispenses: 72,
			sawWellParams: true
		});
	});

	it('counts a single-column selection as 1 well per cartridge', () => {
		expect(countReagentWork({ well_2a: true }, 24)).toEqual({
			reagentGroups: 1,
			dispenses: 24,
			sawWellParams: true
		});
	});

	it('sums rows and columns that are selected together', () => {
		const { reagentGroups, dispenses } = countReagentWork(
			{ well_2: true, well_3: true, well_4a: true },
			24
		);
		expect(reagentGroups).toBe(3);
		expect(dispenses).toBe(72 + 72 + 24);
	});

	it('ignores rows that are present but off', () => {
		const w = countReagentWork({ well_2: true, well_3: false, well_4: false, well_5: false }, 24);
		expect(w.reagentGroups).toBe(1);
		expect(w.dispenses).toBe(72);
		expect(w.sawWellParams).toBe(true);
	});

	it('reports sawWellParams=false when the parameters were never captured', () => {
		expect(countReagentWork({ cartridges: 24 }, 24).sawWellParams).toBe(false);
	});
});

describe('estimateReagentRunSeconds', () => {
	/**
	 * Regression guard on the fit. These are the fastest measured runs of each
	 * shape in reagent_batch_records — the fastest run of a shape carries the
	 * least operator dwell, so it is the closest thing to robot-only time.
	 * If the model drifts more than 2 minutes from any of them, the constants
	 * need re-fitting rather than the test needs relaxing.
	 */
	const measured = [
		{ carts: 15, rows: 4, actualMin: 15.4 },
		{ carts: 16, rows: 4, actualMin: 16.5 },
		{ carts: 23, rows: 3, actualMin: 17.3 },
		{ carts: 22, rows: 4, actualMin: 21.0 },
		{ carts: 24, rows: 4, actualMin: 22.0 }
	];

	for (const { carts, rows, actualMin } of measured) {
		it(`is within 2 min of the ${carts}-cartridge / ${rows}-row run (${actualMin} min)`, () => {
			const params: Record<string, boolean> = {};
			for (const key of ['well_2', 'well_3', 'well_4', 'well_5'].slice(0, rows)) params[key] = true;

			const predictedMin = estimateReagentRunSeconds(params, carts).seconds / 60;
			expect(Math.abs(predictedMin - actualMin)).toBeLessThan(2);
		});
	}

	it('no longer doubles a full 24-cartridge deck the way the flat 2 min/cartridge rate did', () => {
		const { seconds } = estimateReagentRunSeconds(ALL_FOUR_ROWS, 24);
		// The old formula was 24 × 2 min = 48 min against a 22-25 min reality.
		expect(seconds / 60).toBeGreaterThan(18);
		expect(seconds / 60).toBeLessThan(28);
	});

	it('scales down when fewer reagent rows are selected', () => {
		const four = estimateReagentRunSeconds(ALL_FOUR_ROWS, 24).seconds;
		const one = estimateReagentRunSeconds({ well_2: true }, 24).seconds;
		expect(one).toBeLessThan(four / 2);
	});

	it('honours tuning overrides from settings', () => {
		const base = estimateReagentRunSeconds({ well_2: true }, 10, {
			startupOverheadSec: 0,
			secondsPerReagentGroup: 0,
			secondsPerDispense: 1
		});
		expect(base.seconds).toBe(30); // 10 cartridges × 3 wells × 1 s
	});

	it('falls back to the defaults for missing or nonsensical tuning values', () => {
		const withJunk = estimateReagentRunSeconds(ALL_FOUR_ROWS, 24, {
			secondsPerDispense: Number.NaN,
			startupOverheadSec: -5
		} as any);
		expect(withJunk.seconds).toBe(estimateReagentRunSeconds(ALL_FOUR_ROWS, 24).seconds);
		expect(DEFAULT_REAGENT_RUN_TUNING.secondsPerDispense).toBeGreaterThan(0);
	});

	it('assumes a full four-row deck when no well parameters were recorded', () => {
		const blind = estimateReagentRunSeconds({ cartridges: 24 }, 24);
		expect(blind.fellBackToCartridgeCount).toBe(true);
		expect(blind.seconds).toBe(estimateReagentRunSeconds(ALL_FOUR_ROWS, 24).seconds);
	});

	it('flags the calibration check, which ends in an unbounded operator pause', () => {
		expect(
			estimateReagentRunSeconds({ ...ALL_FOUR_ROWS, run_calibration_check: true }, 24).hasOperatorPause
		).toBe(true);
		expect(estimateReagentRunSeconds(ALL_FOUR_ROWS, 24).hasOperatorPause).toBe(false);
	});

	it('does not produce a negative or NaN estimate for a zero-cartridge run', () => {
		const { seconds } = estimateReagentRunSeconds(ALL_FOUR_ROWS, 0);
		expect(Number.isFinite(seconds)).toBe(true);
		expect(seconds).toBeGreaterThanOrEqual(0);
	});
});
