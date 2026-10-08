import { describe, it, expect } from 'vitest';
import { startFromTrips, CAL_PROBE_RECIPES, CAL_PROBE_Y, START_MARGIN_MM } from './tip-calibrator-probe';

// Forward model of _probe_axis in ot2-bridge.py: where each switch closes for a
// given saved point and travel.
const xTripAt = (profile: 'wax' | 'reagent', cal: { x: number; y: number }, travel: number) => ({
	x: cal.x + CAL_PROBE_RECIPES[profile].xDx - travel,
	y: cal.y + CAL_PROBE_RECIPES[profile].xDy
});
const yTripAt = (cal: { x: number; y: number }, travel: number) => ({
	x: cal.x + CAL_PROBE_Y.dx,
	y: cal.y + CAL_PROBE_Y.dy - travel
});

describe('startFromTrips', () => {
	for (const profile of ['wax', 'reagent'] as const) {
		it(`${profile}: the probe from the derived point trips exactly where the operator did, ${START_MARGIN_MM} mm in`, () => {
			const xTrip = { x: 290.1, y: 72.3, z: 23.9 };
			const yTrip = { x: 303.5, y: 70.0, z: 23.8 };
			const s = startFromTrips(profile, xTrip, yTrip);
			const fx = xTripAt(profile, s, START_MARGIN_MM);
			const fy = yTripAt(s, START_MARGIN_MM);
			expect(fx.x).toBeCloseTo(xTrip.x, 3);
			expect(fy.y).toBeCloseTo(yTrip.y, 3);
		});
	}

	it('never returns the trip point itself (the old "use as calibrator" bug)', () => {
		const s = startFromTrips('reagent', { x: 290, y: 72, z: 24 }, { x: 303, y: 70, z: 24 });
		expect(s.x).toBeCloseTo(290 + 1.4 + 2.5, 3);
		expect(s.y).toBeCloseTo(70 + 7.5 + 2.5, 3);
	});

	it('round-trips a known calibrator point', () => {
		const cal = { x: 294.88, y: 79.24 };
		const t = 3.1;
		const xt = { ...xTripAt('reagent', cal, t), z: 23.85 };
		const yt = { ...yTripAt(cal, t), z: 23.85 };
		const s = startFromTrips('reagent', xt, yt, t);
		expect(s.x).toBeCloseTo(cal.x, 3);
		expect(s.y).toBeCloseTo(cal.y, 3);
		expect(s.xLineOffsetMm).toBeCloseTo(0, 3);
		expect(s.yLineOffsetMm).toBeCloseTo(0, 3);
		expect(s.warnings).toEqual([]);
		expect(s.tripZ).toBeCloseTo(23.85, 3);
	});

	it('warns when a switch was touched far from the line its probe runs along', () => {
		const s = startFromTrips('reagent', { x: 290, y: 60, z: 24 }, { x: 290, y: 70, z: 24 });
		expect(s.warnings.length).toBe(2);
	});

	it('warns when the two touches were at different heights', () => {
		const cal = { x: 294.88, y: 79.24 };
		const xt = { ...xTripAt('reagent', cal, 2.5), z: 22 };
		const yt = { ...yTripAt(cal, 2.5), z: 24 };
		expect(startFromTrips('reagent', xt, yt).warnings).toHaveLength(1);
	});
});
