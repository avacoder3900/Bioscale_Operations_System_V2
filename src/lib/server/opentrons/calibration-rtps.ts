/**
 * NATIVE-CALIBRATION-SYSTEM PRD 6 — compute the BIMS-native calibration runtime
 * parameters for a wax/reagent run.
 *
 * The cutover protocols expose RTPs: bims_native, offset_x/y/z (global deck
 * offset → applied to ALL labware), cal_x/cal_y/z_cal (tip-calibrator point).
 * This resolves them from RobotDeckOffset + TipCalibratorFixture and returns
 * ONLY the keys the uploaded protocol actually declares (passed via the param
 * schema) — so it's safe against a robot still running the pre-cutover .py
 * (unknown RTPs make POST /runs fail).
 *
 * Safety: bims_native is set True only when a RobotDeckOffset row exists for the
 * robot. With no row, bims_native stays absent/False and the protocol falls back
 * to its built-in per-robot table = current behavior. The reference robot's row
 * is 0,0,0, so its "apply to all labware" is a positional no-op.
 */
import { connectDB, RobotDeckOffset } from '$lib/server/db';
import {
	DEFAULT_CALIBRATOR_XY,
	loadCalibratorFixture,
	plausibleZ,
	taughtXY,
	Z_CAL_FOR_PROCESS
} from '$lib/server/services/deck-calibration/tip-calibrator';

type ParamDef = { variableName: string };

export async function calibrationRtpValues(
	robotId: string,
	processType: 'wax-filling' | 'reagent-filling',
	paramSchema: ParamDef[]
): Promise<Record<string, number | boolean>> {
	await connectDB();
	const declared = new Set((paramSchema ?? []).map((p) => p.variableName));
	const out: Record<string, number | boolean> = {};
	// If the uploaded protocol has none of the cutover RTPs, it's the old .py —
	// inject nothing.
	if (!declared.has('bims_native')) return out;

	const off = (await RobotDeckOffset.findOne({ robotId }).lean()) as any;
	// Same fallback chain the calibration wizard uses: this robot's taught point,
	// else the shared 'global' one. One helper owns that order.
	const { fixture: fix } = await loadCalibratorFixture(robotId);

	// Drive BIMS-native offset only when a captured offset exists for this robot.
	out['bims_native'] = !!off;
	if (off) {
		const o = off.offset ?? { x: 0, y: 0, z: 0 };
		if (declared.has('offset_x')) out['offset_x'] = Number(o.x ?? 0);
		if (declared.has('offset_y')) out['offset_y'] = Number(o.y ?? 0);
		if (declared.has('offset_z')) out['offset_z'] = Number(o.z ?? 0);
	}
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
	}
	return out;
}
