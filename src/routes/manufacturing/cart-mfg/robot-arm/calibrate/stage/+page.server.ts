/**
 * Robot Arm — Stage Calibration Studio: the robot-arm line's own calibration
 * studio, organised exactly like the Deck Calibration Studio (2D plane of the
 * holes, jog, tip calibration, offset → selection, tour / fill motion, set
 * position, align, recent edits) but for ONE cartridge on an elevated stage.
 *
 * What is taught here, per OT-2 (ArmWaxFillCalibration), is everything the
 * stage protocol (protocols/Wax_Filling_GEN7_ArmStage.py) reads instead of a deck:
 *
 *   scan position    where the gantry scanner reads the cart — taught with NO tip
 *   cart location    the rim of the cart's first wax hole — taught with a PROBED
 *                    tip, stored tip-neutral (live − that tip's calibrator adjust)
 *   hole offsets     per-hole corrections on the rigid 12-hole lattice (the
 *                    Studio's Apply / Set position / Align / Undo) → hole_NN_dx/dy/dz
 *   dispense depth   how far below the rim the tip end sits when wax is
 *                    dispensed (negative = hover) → dispense_depth
 *   stage geometry   the cart's rotation on the stage and the travel height
 *   calibrator       this robot's tip-calibrator fixture point (robot-keyed)
 *
 * DRY FILL (rebuilt 2026-11-06): the page plays the stage protocol's fill of one
 * cart (loadStageCalibration's dryFill plan) in its own Jog run, on the tip
 * already on the pipette; dryFillRecord logs each one.
 *
 * All logic is in $lib/server/arm-wax-fill; this file maps form fields to it.
 */
import { fail, redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import {
	ArmWaxFillError,
	applyStageEdits,
	getSettings,
	loadStageCalibration,
	recordDryFill,
	resetLoop,
	saveCartLocation,
	saveDispenseDepth,
	saveScanPosition,
	saveStageCalibrator,
	saveStageGeometry,
	switchRobot
} from '$lib/server/arm-wax-fill';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	const page = await loadStageCalibration();
	return JSON.parse(JSON.stringify(page)) as typeof page;
};

const who = (locals: App.Locals) => ({ _id: locals.user!._id, username: locals.user!.username });
const field = (d: FormData, k: string) => d.get(k)?.toString() ?? null;
const json = (v: unknown) => JSON.parse(JSON.stringify(v));

function failFrom(err: unknown) {
	if (err instanceof ArmWaxFillError) return fail(err.status, { error: err.message });
	console.error('[stage-calibration]', err);
	return fail(500, { error: err instanceof Error ? err.message : 'Unexpected error.' });
}

async function writer({ request, locals }: { request: Request; locals: App.Locals }) {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:write');
	const robotId = (await getSettings()).robotId ?? '';
	return { d: await request.formData(), user: who(locals), robotId };
}

export const actions: Actions = {
	// The robot bar's menu (as on the Run page): only the robot changes, the rest of Setup stays.
	switchRobot: async (ev) => {
		const { d, user } = await writer(ev);
		try {
			const settings = await switchRobot(user, field(d, 'robotId'));
			return { success: 'Robot switched.', settings: json(settings) };
		} catch (err) {
			return failFrom(err);
		}
	},

	// The robot bar's Recover: end any running loop now; the page then forces the OT-2 back to idle.
	resetLoop: async (ev) => {
		const { user } = await writer(ev);
		try {
			return json(await resetLoop(user));
		} catch (err) {
			return failFrom(err);
		}
	},

	saveScanPosition: async (ev) => {
		const { d, user, robotId } = await writer(ev);
		try {
			const c = await saveScanPosition(user, robotId, {
				x: field(d, 'x'),
				y: field(d, 'y'),
				z: field(d, 'z'),
				pipetteMount: field(d, 'pipetteMount'),
				pipetteName: field(d, 'pipetteName'),
				testScanBarcode: field(d, 'testScanBarcode')
			});
			return { success: 'Scan position saved.', calibration: json(c) };
		} catch (err) {
			return failFrom(err);
		}
	},

	// Saved tip-neutral: live position + the probe adjust of the tip it was taught with.
	saveCartLocation: async (ev) => {
		const { d, user, robotId } = await writer(ev);
		try {
			const c = await saveCartLocation(user, robotId, {
				x: field(d, 'x'),
				y: field(d, 'y'),
				z: field(d, 'z'),
				pipetteMount: field(d, 'pipetteMount'),
				pipetteName: field(d, 'pipetteName'),
				hasTip: field(d, 'hasTip'),
				adjustX: field(d, 'adjustX'),
				adjustY: field(d, 'adjustY'),
				tipWell: field(d, 'tipWell')
			});
			return { success: 'First hole saved (tip-neutral) — the 12 holes are laid out from it.', calibration: json(c) };
		} catch (err) {
			return failFrom(err);
		}
	},

	// The Studio's apply engine: each hole by its own delta; every hole with one
	// delta = the whole cart translated (see applyStageEdits).
	applyPerWell: async (ev) => {
		const { d, user, robotId } = await writer(ev);
		try {
			const r = await applyStageEdits(user, robotId, field(d, 'edits'), field(d, 'label'));
			return { applied: r.applied, failed: r.failed, mode: r.mode, calibration: json(r.calibration) };
		} catch (err) {
			return failFrom(err);
		}
	},

	// The tip end's live Z over a hole → depth below the taught rim.
	saveDispenseDepth: async (ev) => {
		const { d, user, robotId } = await writer(ev);
		try {
			const c = await saveDispenseDepth(user, robotId, { z: field(d, 'z'), hasTip: field(d, 'hasTip') });
			return { success: `Dispense depth saved: ${Math.abs(Number(c.dispenseDepth?.mm))} mm ${Number(c.dispenseDepth?.mm) >= 0 ? 'below' : 'above'} the rim.`, calibration: json(c) };
		} catch (err) {
			return failFrom(err);
		}
	},

	saveStageGeometry: async (ev) => {
		const { d, user, robotId } = await writer(ev);
		try {
			const c = await saveStageGeometry(user, robotId, { rotationDeg: field(d, 'rotationDeg') });
			return { success: `Stage geometry saved: rotation ${c.stageRotationDeg}°.`, calibration: json(c) };
		} catch (err) {
			return failFrom(err);
		}
	},

	// This robot's tip-calibrator fixture (robot-keyed — the arm's OT-2 has no deck).
	saveCalibrator: async (ev) => {
		const { d, user, robotId } = await writer(ev);
		try {
			const r = await saveStageCalibrator(user, robotId, {
				x: field(d, 'x'),
				y: field(d, 'y'),
				z: field(d, 'z'),
				probeZ: field(d, 'probeZ'),
				tipProfile: field(d, 'tipProfile'),
				maxTipAdjust: field(d, 'maxTipAdjust')
			});
			return { success: `Tip calibrator saved: approach (${r.position.x}, ${r.position.y}, ${r.position.z}), probe Z ${r.probeZ} (${r.tipProfile === 'reagent' ? 'p300 · zCalReagent' : 'p20 · zCalWax'})${r.maxTipAdjust != null ? `, max adjust ${r.maxTipAdjust}` : ''}.`, calibrator: r };
		} catch (err) {
			return failFrom(err);
		}
	},

	// A Dry Fill All Holes started or ended (the page plays it in its Jog run).
	dryFillRecord: async (ev) => {
		const { d, user, robotId } = await writer(ev);
		try {
			await recordDryFill(user, robotId, { event: field(d, 'event'), detail: field(d, 'detail') });
			return { ok: true };
		} catch (err) {
			return failFrom(err);
		}
	}
};
