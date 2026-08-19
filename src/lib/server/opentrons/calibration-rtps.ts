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
import { connectDB, TipCalibratorFixture } from '$lib/server/db';

type ParamDef = { variableName: string };

const Z_CAL_DEFAULT = { 'wax-filling': 34.491, 'reagent-filling': 40.8 } as const;

export async function calibrationRtpValues(
	robotId: string,
	processType: 'wax-filling' | 'reagent-filling',
	paramSchema: ParamDef[]
): Promise<Record<string, number | boolean>> {
	await connectDB();
	const declared = new Set((paramSchema ?? []).map((p) => p.variableName));
	const out: Record<string, number | boolean> = {};

	// No cutover RTPs at all => pre-cutover .py. Injecting unknown RTPs makes
	// POST /runs fail, so inject nothing and leave that protocol alone.
	if (!declared.has('bims_native')) return out;

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
	const fix =
		((await TipCalibratorFixture.findOne({ robotId }).lean()) as any) ||
		((await TipCalibratorFixture.findOne({ robotId: 'global' }).lean()) as any);
	if (fix) {
		const p = fix.position ?? {};
		if (declared.has('cal_x') && p.x != null) out['cal_x'] = Number(p.x);
		if (declared.has('cal_y') && p.y != null) out['cal_y'] = Number(p.y);
		if (declared.has('z_cal')) {
			const z = processType === 'wax-filling' ? fix.zCalWax : fix.zCalReagent;
			out['z_cal'] = Number(z ?? Z_CAL_DEFAULT[processType]);
		}
	}
	return out;
}
