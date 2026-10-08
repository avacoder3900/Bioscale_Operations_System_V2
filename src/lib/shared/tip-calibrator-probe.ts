/**
 * Tip-calibrator probe geometry: where the closed-loop probe starts relative to
 * the saved calibrator point, and the inverse — the calibrator point that makes
 * the probe start a known distance before the switches the operator touched in
 * the sensor watch.
 *
 * MIRRORS scripts/ot2-bridge.py (CAL_PROBE_RECIPES, CAL_PROBE_Y_DX/DY,
 * _probe_axis). Change both together. The saved point is NOT where the switches
 * close; it is the reference the probe offsets from:
 *
 *   X probe  starts (calX + xDx, calY + xDy), creeps toward −x, trips the X switch
 *   Y probe  starts (calX + 8.829, calY − 7.5), creeps toward −y, trips the Y switch
 *
 * each for at most PROBE_MAX_TRAVEL_MM. Saving a switch-trip position as the
 * calibrator point would start the X probe 1.4 mm (reagent) past its switch and
 * the Y probe 7.5 mm past its — into the fixture.
 *
 * Isomorphic: no DOM, no $lib/server.
 */

export type TipProfile = 'wax' | 'reagent';
type Vec3 = { x: number; y: number; z: number };

/** X-probe start offsets per fill protocol (Wax_Filling_GEN7 :697 / Reagent_Filling_GEN7 :617). */
export const CAL_PROBE_RECIPES: Record<TipProfile, { xDx: number; xDy: number }> = {
	wax: { xDx: -0.6, xDy: -6.5 },
	reagent: { xDx: -1.4, xDy: -7.0 }
};
/** Y-probe start offsets — identical in both protocols. */
export const CAL_PROBE_Y = { dx: 8.829, dy: -7.5 } as const;
/** How far _probe_axis creeps before declaring the switch unreached. */
export const PROBE_MAX_TRAVEL_MM = 5;
/**
 * How far before each touched switch the probe should start: the middle of the
 * 5 mm window, so a tip bent either way by up to 2.5 mm still trips in range.
 */
export const START_MARGIN_MM = 2.5;
/**
 * A trip further than this from the line the probe will actually run along means
 * the operator touched a different part of the paddle than the probe will.
 */
export const PROBE_LINE_WARN_MM = 2;

export interface StartFromTrips {
	/** The calibrator point to save (x/y). */
	x: number;
	y: number;
	/** Mean height the two switches closed at — the depth they were touched at. */
	tripZ: number;
	/** Where each probe will start, for display. */
	xProbeStart: { x: number; y: number };
	yProbeStart: { x: number; y: number };
	/** Distance between each trip and the line its probe will run along. */
	xLineOffsetMm: number;
	yLineOffsetMm: number;
	warnings: string[];
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * The calibrator point for which the probe starts `margin` mm before the switch
 * positions the operator touched: x from the X trip, y from the Y trip.
 */
export function startFromTrips(
	profile: TipProfile,
	xTrip: Vec3,
	yTrip: Vec3,
	margin: number = START_MARGIN_MM
): StartFromTrips {
	const recipe = CAL_PROBE_RECIPES[profile];
	// X probe trips at calX + xDx − travel; solve for travel = margin.
	const x = r3(xTrip.x - recipe.xDx + margin);
	// Y probe trips at calY + dy − travel; solve for travel = margin.
	const y = r3(yTrip.y - CAL_PROBE_Y.dy + margin);

	const xProbeStart = { x: r3(x + recipe.xDx), y: r3(y + recipe.xDy) };
	const yProbeStart = { x: r3(x + CAL_PROBE_Y.dx), y: r3(y + CAL_PROBE_Y.dy) };
	// The X probe runs along y = xProbeStart.y; the Y probe along x = yProbeStart.x.
	const xLineOffsetMm = r3(Math.abs(xTrip.y - xProbeStart.y));
	const yLineOffsetMm = r3(Math.abs(yTrip.x - yProbeStart.x));

	const warnings: string[] = [];
	if (xLineOffsetMm > PROBE_LINE_WARN_MM) {
		warnings.push(
			`The X switch was touched ${xLineOffsetMm} mm from where the X probe will run (y ${xProbeStart.y}).`
		);
	}
	if (yLineOffsetMm > PROBE_LINE_WARN_MM) {
		warnings.push(
			`The Y switch was touched ${yLineOffsetMm} mm from where the Y probe will run (x ${yProbeStart.x}).`
		);
	}
	const tripZ = r3((xTrip.z + yTrip.z) / 2);
	if (Math.abs(xTrip.z - yTrip.z) > 1) {
		warnings.push(`The two switches were touched ${r3(Math.abs(xTrip.z - yTrip.z))} mm apart in height.`);
	}

	return { x, y, tripZ, xProbeStart, yProbeStart, xLineOffsetMm, yLineOffsetMm, warnings };
}
