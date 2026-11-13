import { describe, it, expect } from 'vitest';
import {
	UNTRACKED_LOT_ID,
	diluentFloorUl,
	diluentMinSourceUl,
	diluentTubesPerTrip,
	diluentRunTimeParameters,
	diluentEstimateSeconds,
	validateDiluentSetup,
	ulToMlUp
} from './diluent-fill';

// The numbers the robot protocol (Sample_Diluent_Fill_v2.py) printed in simulation on
// 2026-11-13: 40 tubes × 104.5 µL needs 5.50 mL with the P1000 (1.30 mL unreachable),
// 10.25 mL with the P300. BIMS must show the operator the same minimum.
describe('diluent source minimum', () => {
	it('matches the protocol: P1000, 40 tubes → 5.51 mL (1.30 mL unreachable, 5500.2 µL rounded up to 10 µL)', () => {
		expect(diluentFloorUl('p1000')).toBeCloseTo(1300.2, 0);
		expect(diluentMinSourceUl('p1000', 40, 104.5)).toBe(5510);
		expect(ulToMlUp(diluentMinSourceUl('p1000', 40, 104.5))).toBe(5.51);
	});
	it('matches the protocol: P300, 40 tubes → 10.26 mL (6.06 mL unreachable)', () => {
		expect(diluentFloorUl('p300')).toBeCloseTo(6063, -1);
		expect(diluentMinSourceUl('p300', 40, 104.5)).toBe(10_260);
		expect(ulToMlUp(diluentMinSourceUl('p300', 40, 104.5))).toBe(10.26);
	});
	it('is zero for an unused source', () => {
		expect(diluentMinSourceUl('p1000', 0, 104.5)).toBe(0);
	});
});

describe('tubes per aspirate', () => {
	it('is 8 on the P1000 at 104.5 µL and 1 on the P300 (200 µL tip)', () => {
		expect(diluentTubesPerTrip('p1000', 8, 104.5)).toBe(8);
		expect(diluentTubesPerTrip('p300', 8, 104.5)).toBe(1);
	});
	it('shrinks with the volume so the tip never overfills', () => {
		expect(diluentTubesPerTrip('p1000', 8, 300)).toBe(3); // 3 × 300 + 20 = 920 ≤ 1000
		expect(diluentTubesPerTrip('p1000', 2, 104.5)).toBe(2);
		expect(diluentTubesPerTrip('p1000', 0, 104.5)).toBe(1);
	});
});

const run = {
	pipette: 'p1000' as const,
	diluentVolumeUl: 104.5,
	tubesPerTrip: 8,
	sources: [
		{ well: 'A1', reagentLotId: 'lot1', tubesPlanned: 40, loadedMl: 6 },
		{ well: 'A2', reagentLotId: 'lot2', tubesPlanned: 13, loadedMl: 3 },
		{ well: 'A3', reagentLotId: null, tubesPlanned: 0, loadedMl: 0 }
	]
};

describe('run-time parameters from the record', () => {
	it('maps the three sources, the pipette, the volume and the clamped tubes per trip', () => {
		expect(diluentRunTimeParameters(run)).toEqual({
			pipette: 'p1000',
			diluent_vol: 104.5,
			tubes_per_trip: 8,
			src_1_tubes: 40, src_1_ml: 6,
			src_2_tubes: 13, src_2_ml: 3,
			src_3_tubes: 0, src_3_ml: 0
		});
	});
	it('estimates longer runs for more trips', () => {
		expect(diluentEstimateSeconds(run)).toBeGreaterThan(diluentEstimateSeconds({ ...run, sources: [run.sources[0]] }));
		expect(diluentEstimateSeconds({ ...run, pipette: 'p300' })).toBeGreaterThan(diluentEstimateSeconds(run));
	});
});

describe('setup validation', () => {
	it('accepts a complete setup', () => {
		expect(validateDiluentSetup(run)).toEqual([]);
	});
	it('accepts the untracked placeholder lot (2026-11-13: diluent stock is not a tracked lot yet)', () => {
		const placeholder = { ...run, sources: [{ well: 'A1', reagentLotId: UNTRACKED_LOT_ID, reagentLotBarcode: 'bench diluent 11/13', tubesPlanned: 40, loadedMl: 6 }] };
		expect(validateDiluentSetup(placeholder)).toEqual([]);
	});
	it('refuses a source that is short, missing its lot, or over 40 tubes', () => {
		const short = { ...run, sources: [{ well: 'A1', reagentLotId: 'lot1', tubesPlanned: 40, loadedMl: 3 }] };
		expect(validateDiluentSetup(short)[0]).toMatch(/A1: 3 mL loaded but 40 tubes need at least 5.51 mL/);
		const noLot = { ...run, sources: [{ well: 'A1', reagentLotId: null, tubesPlanned: 5, loadedMl: 6 }] };
		expect(validateDiluentSetup(noLot)[0]).toMatch(/A1: pick the reagent lot/);
		const tooMany = { ...run, sources: [{ well: 'A1', reagentLotId: 'lot1', tubesPlanned: 41, loadedMl: 15 }] };
		expect(validateDiluentSetup(tooMany)[0]).toMatch(/A1: tubes must be 0–40/);
	});
	it('refuses an empty plan and an out-of-range volume', () => {
		expect(validateDiluentSetup({ ...run, sources: [] })).toContain('Plan at least one tube.');
		expect(validateDiluentSetup({ ...run, diluentVolumeUl: 500 })[0]).toMatch(/between 8 and 300/);
	});
});
