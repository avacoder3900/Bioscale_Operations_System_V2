/**
 * Calibration runtime parameters for a wax/reagent run.
 *
 * POSITIONAL MODEL (2026-08-19). There is exactly ONE source of truth for where
 * a hole is: the deck's labware definition in Mongo. Nothing else is allowed to
 * move the pipette relative to it. The only correction applied on top is the
 * per-tip probe, which measures how far THIS tip is bent and is re-measured at
 * every tip pickup.
 *
 * That means every global offset is now forced to zero:
 *
 *   offset_x/y/z = 0   ->  carriage.set_offset(0,0,0), and the same for the tube
 *                          rack and tip rack, i.e. positional no-ops.
 *
 * `bims_native` is forced TRUE, and that is load-bearing rather than cosmetic.
 * The protocol falls back to a hardcoded ROBOT_OFFSETS table when bims_native is
 * false, and that table is NOT all zeros (hidden-leaf / B07 carries
 * {0.15, -0.25, -1.3}). Simply deleting the RobotDeckOffset rows would therefore
 * REINTRODUCE offsets rather than remove them. Sending bims_native=true with
 * zeros is what actually disables both layers.
 *
 * Why the global offset had to go: the Deck Calibration Studio jogs through the
 * maintenance API, which reads the labware definition and applies NO global
 * offset. A production run applied one. So the position an operator physically
 * verified in the Studio was not the position the run used — on 2026-08-19 R04
 * carried x=+1mm, which pushed every wax hole 1mm right of the verified spot.
 * The same mistake hit B14 on 2026-07-01 and caused the 07-08 deck-004 misses.
 *
 * cal_x / cal_y / z_cal are KEPT. They are not a correction to hole positions —
 * they are where the tip-calibrator fixture physically sits, i.e. where the
 * robot must travel to measure a tip. They are legitimately per-robot.
 */
// RobotDeckOffset is deliberately NOT imported: the positional model above
// forces every global offset to zero, so there is nothing left to read.
// TipCalibratorFixture is reached through loadCalibratorFixture, which owns the
// per-robot → 'global' fallback order the wizard uses.
import { connectDB } from '$lib/server/db';
import {
	DEFAULT_CALIBRATOR_XY,
	loadCalibratorFixture,
	plausibleZ,
	taughtXY,
	Z_CAL_FOR_PROCESS
} from '$lib/server/services/deck-calibration/tip-calibrator';

type ParamDef = { variableName: string; min?: number; max?: number };

export async function calibrationRtpValues(
	robotId: string,
	processType: 'wax-filling' | 'reagent-filling',
	paramSchema: ParamDef[],
	/**
	 * The deck this run will fill (2026-08-28). The calibrator fixture is bolted
	 * to the carriage, so its point is keyed by the deck — pass the deck and the
	 * run gets the calibrator that is physically mounted, not whatever was last
	 * taught on this robot. Omitted = legacy robot-keyed lookup.
	 */
	deck: { deckKey?: string | null; deckLoadName?: string | null } = {}
): Promise<Record<string, number | boolean>> {
	await connectDB();
	const declared = new Set((paramSchema ?? []).map((p) => p.variableName));
	const out: Record<string, number | boolean> = {};

	// No cutover RTPs at all => pre-cutover .py. Injecting unknown RTPs makes
	// POST /runs fail, so inject nothing and leave that protocol alone.
	if (!declared.has('bims_native')) return out;

	// MERGE NOTE (2026-08-21, feat/tip-calibrator-teach → master): the offset policy
	// below is master's and is kept verbatim. The branch predated it and still read
	// RobotDeckOffset, which would have REINTRODUCED the wrong-hole dispense the
	// comment describes. What the branch contributes here is the GUARDED read of the
	// calibrator point further down (taughtXY / plausibleZ), which master still did
	// with bare finite() reads. Both survive.

	// Always native, always zero. See the header: this is what disables BOTH the
	// stored per-robot offset and the protocol's hardcoded fallback table.
	out['bims_native'] = true;
	if (declared.has('offset_x')) out['offset_x'] = 0;
	if (declared.has('offset_y')) out['offset_y'] = 0;
	if (declared.has('offset_z')) out['offset_z'] = 0;

	// The per-tip probe is the ONLY correction left, so it is not optional.
	//
	// Deck holes are taught in the Studio with "Calibrate tip" active, which means
	// the stored coordinates are tip-NEUTRAL: they only land when the fill applies
	// the same probe adjust. Running with the probe off does not fall back to
	// "uncorrected" — it parks the tip on the REAGENT hole instead of the wax one
	// (confirmed on B07/deck-004, 2026-08-18). That is a wrong-hole dispense, not a
	// small error, so it must not be reachable by an operator toggle or a stale
	// form default.
	//
	// A dead calibrator is therefore a STOP condition, not a reason to switch this
	// off. max_tip_adjust still rejects an implausible probe and falls back to
	// nominal for that tip.
	if (declared.has('use_tip_calibration')) out['use_tip_calibration'] = true;

	// Tip-calibrator fixture location — where to go to measure, not a hole shift.
	// Same fallback chain the calibration wizard uses: this robot's taught point,
	// else the shared 'global' one. One helper owns that order.
	const { fixture: fix } = await loadCalibratorFixture(robotId, deck);
	// With no fixture at all we inject nothing and let the .py keep its own
	// built-in calibrator point — same as before the wizard existed.
	if (fix) {
		// Guarded exactly like the probe path (resolveCalibratorPoint), NOT with a bare
		// finite() read. The difference is not cosmetic:
		//
		//   • position.x/y DEFAULT TO 0 in the fixture schema, so a row saved before the
		//     operator ever taught a point holds a real, finite 0. finite(0) === 0 passed
		//     that straight through as cal_x/cal_y and sent a production run to the deck's
		//     front-left corner at full confidence. taughtXY() treats 0 as "never taught"
		//     and falls back to the .py's own calibrator point instead.
		//   • z_cal is the touch-off depth. finite() accepted 0, negative, or 500mm; and
		//     finite(null) === 0 (Number(null) === 0), so a field explicitly written null
		//     became a probe depth of 0 — straight through the deck. plausibleZ() holds it
		//     to CAL_Z_LIMITS and falls back to the .py default.
		//
		// Production must never be laxer than the wizard that teaches it.
		const p = fix.position ?? {};
		if (declared.has('cal_x')) out['cal_x'] = taughtXY(p.x) ?? DEFAULT_CALIBRATOR_XY.x;
		if (declared.has('cal_y')) out['cal_y'] = taughtXY(p.y) ?? DEFAULT_CALIBRATOR_XY.y;
		if (declared.has('z_cal')) {
			const { zCalKey, defaultZ } = Z_CAL_FOR_PROCESS[processType];
			out['z_cal'] = plausibleZ(fix[zCalKey]) ?? defaultZ;
		}

		// Per-robot rejection cap for the tip probe.
		//
		// The protocol compares this against the RAW adjust, which is
		// `calibrator baseline - travel-to-switch` and so carries that fixture's
		// dialled baseline. R04's baseline is -5.0, making a perfectly normal wax
		// adjust about -6.0; the protocol's 4.0 default rejected every one of them
		// and fell back to NOMINAL — which is ~5.7mm off, because the holes were
		// taught with the adjust applied. B07's baseline is -1.0 (normal adjust
		// ~-2.2), so a single global cap cannot be tight enough there and loose
		// enough on R04 at once.
		//
		// Clamped to the bound the uploaded protocol actually declares: a robot
		// still running the pre-2026-08-20 .py caps at 5.0, and sending more would
		// make POST /runs fail outright instead of merely being too strict.
		if (declared.has('max_tip_adjust') && fix.maxTipAdjust != null) {
			const spec = (paramSchema ?? []).find((p) => p.variableName === 'max_tip_adjust');
			const ceiling = Number(spec?.max);
			const wanted = Number(fix.maxTipAdjust);
			out['max_tip_adjust'] = Number.isFinite(ceiling) ? Math.min(wanted, ceiling) : wanted;
		}
	}
	return out;
}
