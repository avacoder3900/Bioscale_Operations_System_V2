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
import { connectDB, Equipment } from '$lib/server/db';
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
		// The p300 / air REHEARSAL of the arm stage fill (protocols/
		// Wax_Filling_GEN7_ArmStage_Rehearsal_p300.py) runs as the wax process but
		// probes a p300 / 200 µL tip, so it declares its own probe depth,
		// z_cal_p300, and reads the fixture's REAGENT depth — what the Stage
		// Calibration Studio teaches while that protocol is on the robot. The
		// p20's z_cal above is still injected and simply goes unread.
		if (declared.has('z_cal_p300')) {
			const { zCalKey, defaultZ } = Z_CAL_FOR_PROCESS['reagent-filling'];
			out['z_cal_p300'] = plausibleZ(fix[zCalKey]) ?? defaultZ;
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

		// Per-robot wax-tube aspiration floor (2026-09-17). The wax .py clamps the
		// aspirating tip to `tube bottom + min_tip_clearance` and models the liquid
		// from a hardcoded 50uL dead volume, so every run ends on that floor. How far
		// above the physical tube bottom the floor really is depends on how accurate
		// the robot's Z frame is — and that differs per robot:
		//
		//   • B07: taught deck-004 Z equals the deck file's design height, i.e. the
		//     model is physically accurate, so the protocol's 1.5mm default really is
		//     1.5mm above a conical 2ml tube's apex. The p20 tip wall wedges in the
		//     cone, bends, and the last 4-5 cartridges of carrier 3 fill badly.
		//   • R04: taught deck-001 Z sits ~4-5mm BELOW its design height (the model
		//     thinks the tip is lower than it is), so at the untaught wax tube the
		//     same 1.5mm floor is physically ~6mm — and raising it would lift the tip
		//     out of the wax at the end of a run.
		//
		// So this is a fixture (robot + deck) value, not a fleet default. Absent =>
		// nothing injected and the .py default (1.5) stands. Wax only: the reagent
		// protocol declares the same RTP for a different tube rack and has been fine.
		if (processType === 'wax-filling' && declared.has('min_tip_clearance') && fix.minTipClearanceWaxMm != null) {
			const spec = (paramSchema ?? []).find((p) => p.variableName === 'min_tip_clearance');
			const wanted = Number(fix.minTipClearanceWaxMm);
			const lo = Number(spec?.min), hi = Number(spec?.max);
			if (Number.isFinite(wanted) && wanted > 0) {
				let v = wanted;
				if (Number.isFinite(hi)) v = Math.min(v, hi);
				if (Number.isFinite(lo)) v = Math.max(v, lo);
				out['min_tip_clearance'] = v;
			}
		}
	}
	return out;
}

/** The calibrator RTPs a Start panel shows read-only, and the deck they were read for. */
export interface CalibrationPreview {
	/** cal_x / cal_y / z_cal exactly as Start will inject them (empty when no fixture exists). */
	values: Record<string, number>;
	/** The deck these values belong to. */
	deckId: string | null;
	/** 'run' = the run's scanned deck; 'last-run' = this robot's last scanned deck (not scanned yet). */
	deckSource: 'run' | 'last-run' | null;
}

/**
 * What Start will inject for the calibrator point, for display BEFORE Start.
 *
 * The Start panel seeds its fields from the protocol file's defaults (z_cal 40.8),
 * but Start overwrites cal_x / cal_y / z_cal with the deck's TipCalibratorFixture
 * (calibrationRtpValues above). Showing the file default made operators think a
 * saved probe Z had not taken (R04 / DECK-001, 2026-10-21). This runs the SAME
 * lookup for the same deck, so the panel shows the number the robot will get.
 *
 * Before the deck scan the run has no deckId; the robot's most recently scanned
 * deck is used and flagged 'last-run' — Start still re-reads the scanned deck.
 */
export async function calibrationPreview(
	robotId: string,
	processType: 'wax-filling' | 'reagent-filling',
	deckId: string | null | undefined,
	lastDeckId: string | null | undefined
): Promise<CalibrationPreview> {
	const pick = deckId ? { id: deckId, source: 'run' as const } : lastDeckId ? { id: lastDeckId, source: 'last-run' as const } : null;
	let deck: { deckKey?: string | null; deckLoadName?: string | null } = {};
	if (pick) {
		await connectDB();
		const eq = (await Equipment.findOne({ _id: pick.id, equipmentType: 'deck' }).select('particleDeviceId deckLoadName').lean()) as any;
		if (eq) deck = { deckKey: eq.particleDeviceId ?? null, deckLoadName: eq.deckLoadName ?? null };
	}
	const schema = ['bims_native', 'cal_x', 'cal_y', 'z_cal'].map((variableName) => ({ variableName }));
	const out = await calibrationRtpValues(robotId, processType, schema, deck);
	const values: Record<string, number> = {};
	for (const k of ['cal_x', 'cal_y', 'z_cal']) if (typeof out[k] === 'number') values[k] = out[k] as number;
	return { values, deckId: pick?.id ?? null, deckSource: pick?.source ?? null };
}
