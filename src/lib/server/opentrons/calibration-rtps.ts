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
import { connectDB, RobotDeckOffset, TipCalibratorFixture } from '$lib/server/db';

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
	// If the uploaded protocol has none of the cutover RTPs, it's the old .py —
	// inject nothing.
	if (!declared.has('bims_native')) return out;

	const off = (await RobotDeckOffset.findOne({ robotId }).lean()) as any;
	const fix =
		((await TipCalibratorFixture.findOne({ robotId }).lean()) as any) ||
		((await TipCalibratorFixture.findOne({ robotId: 'global' }).lean()) as any);

	// Drive BIMS-native offset only when a captured offset exists for this robot.
	out['bims_native'] = !!off;
	if (off) {
		const o = off.offset ?? { x: 0, y: 0, z: 0 };
		if (declared.has('offset_x')) out['offset_x'] = Number(o.x ?? 0);
		if (declared.has('offset_y')) out['offset_y'] = Number(o.y ?? 0);
		if (declared.has('offset_z')) out['offset_z'] = Number(o.z ?? 0);
	}
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
