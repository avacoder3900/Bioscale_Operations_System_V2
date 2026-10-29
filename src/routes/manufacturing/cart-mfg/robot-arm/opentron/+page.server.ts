/**
 * Robot Arm — Opentron: the arm line's OT-2 page. Two sections, each with its
 * own Show / Hide so the operator can work on one at a time:
 *
 *   Wax Fill           the arm feeds one cart at a time to the OT-2 running the
 *                      stage wax-filling protocol (Wax_Filling_GEN7_ArmStage.py):
 *                      Setup (robot; deck + deck position only for the legacy
 *                      carriage protocol), the grab / withdraw animations and the
 *                      loop itself. The browser drives a cycle one action at a
 *                      time: homeGantry → cycleGrab → (playback poll, settle) →
 *                      cycleGrabDone → scan over /api/scanner/sweep → cycleScanned
 *                      → cycleFill → (EmbeddedRunController) → cycleFillDone →
 *                      homeGantry → cycleWithdraw → (playback poll, settle) →
 *                      cycleWithdrawDone, and round again.
 *
 *   Stage Calibration  the Stage Calibration Studio — organised like the Deck
 *                      Calibration Studio (2D plane of the holes, jog, tip
 *                      calibration, offset → selection, tour / fill motion, set
 *                      position, align, recent edits) but for ONE cartridge on
 *                      an elevated stage. Teaches, per OT-2 (ArmWaxFillCalibration),
 *                      everything the stage protocol reads instead of a deck:
 *                      scan position (no tip), cart location (probed tip, stored
 *                      tip-neutral), per-hole offsets, dispense depth, stage
 *                      geometry and the robot-keyed tip-calibrator point.
 *
 * The two were sibling tabs (wax-fill, stage-calibration) until 2026-10-29; the
 * old URLs redirect here. Both sections' data is loaded here, namespaced as
 * `wax` and `stage`, and every action of both lives in this one file (the action
 * names never overlapped). All logic is in $lib/server/arm-wax-fill; this file
 * only maps form fields to it.
 */
import { fail, redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { sharedAnimateActions } from '$lib/server/robot-arm-animate-actions';
import {
	ArmWaxFillError,
	applyStageEdits,
	cycleFill,
	cycleFillDone,
	cycleGrab,
	cycleGrabDone,
	cycleHomeGantry,
	cycleScanned,
	cycleWithdraw,
	cycleWithdrawDone,
	failLoop,
	getLoop,
	getSettings,
	loadArmWaxFill,
	loadStageCalibration,
	resetLoop,
	saveAnimations,
	saveCartLocation,
	saveDispenseDepth,
	saveScanPosition,
	saveSetup,
	saveStageCalibrator,
	saveStageGeometry,
	startLoop,
	stopLoop
} from '$lib/server/arm-wax-fill';
import type { Actions, PageServerLoad } from './$types';

// The fill step runs the whole OT-2 start (freshness gate, create, play) in one
// action, and homeGantry waits for the OT-2 to finish homing (30–60 s cold).
export const config = { maxDuration: 120 };

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	const [wax, stage] = await Promise.all([loadArmWaxFill(), loadStageCalibration()]);
	return {
		wax: JSON.parse(JSON.stringify(wax)) as typeof wax,
		stage: JSON.parse(JSON.stringify(stage)) as typeof stage
	};
};

const who = (locals: App.Locals) => ({ _id: locals.user!._id, username: locals.user!.username });
const field = (d: FormData, k: string) => d.get(k)?.toString() ?? null;
const json = (v: unknown) => JSON.parse(JSON.stringify(v));

function failFrom(err: unknown) {
	if (err instanceof ArmWaxFillError) return fail(err.status, { error: err.message });
	console.error('[robot-arm/opentron]', err);
	return fail(500, { error: err instanceof Error ? err.message : 'Unexpected error.' });
}

type Ev = { request: Request; locals: App.Locals };

/** Wax Fill actions: manufacturing:write, plus waxFilling:write for the actions that create wax runs. */
async function writer({ request, locals }: Ev, wax = false) {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:write');
	if (wax) requirePermission(locals.user, 'waxFilling:write');
	return { d: await request.formData(), user: who(locals) };
}

/** Stage Calibration actions: manufacturing:write, keyed to the OT-2 the arm feeds. */
async function stageWriter({ request, locals }: Ev) {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:write');
	const robotId = (await getSettings()).robotId ?? '';
	return { d: await request.formData(), user: who(locals), robotId };
}

export const actions: Actions = {
	// ── Wax Fill ──────────────────────────────────────────────────────────────

	// The Playback helper's end-of-play poll and after-play settle (torque back on, droop learn).
	playback: sharedAnimateActions.playback,
	settle: sharedAnimateActions.settle,

	saveSetup: async (ev) => {
		const { d, user } = await writer(ev);
		try {
			await saveSetup(user, {
				robotId: field(d, 'robotId'),
				cartPosition: field(d, 'cartPosition'),
				waxSourceLot: field(d, 'waxSourceLot'),
				testMode: field(d, 'testMode') === 'on' || field(d, 'testMode') === 'true'
			});
			return { success: 'Setup saved.' };
		} catch (err) {
			return failFrom(err);
		}
	},

	// Only reachable after "Change animations" on the page: the choice is kept between runs.
	saveAnimations: async (ev) => {
		const { d, user } = await writer(ev);
		try {
			const s = await saveAnimations(user, { grab: field(d, 'grab'), withdraw: field(d, 'withdraw') });
			return { success: `Animations saved: grab "${s.grabAnimation?.name}", withdraw "${s.withdrawAnimation?.name}".` };
		} catch (err) {
			return failFrom(err);
		}
	},

	startLoop: async (ev) => {
		const { d, user } = await writer(ev, true);
		try {
			return { loop: json(await startLoop(user, field(d, 'runs'))) };
		} catch (err) {
			return failFrom(err);
		}
	},

	loopState: async (ev) => {
		if (!ev.locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(ev.locals.user, 'manufacturing:read');
		const id = field(await ev.request.formData(), 'loopId');
		if (!id) return fail(400, { error: 'loopId missing.' });
		const loop = await getLoop(id);
		return loop ? { loop: json(loop) } : fail(404, { error: 'Loop not found.' });
	},

	// Home the OT-2 gantry before an arm move and stamp the cycle; cycleGrab /
	// cycleWithdraw refuse to play the arm without it. Synchronous on the robot.
	homeGantry: async (ev) => {
		const { d, user } = await writer(ev);
		const id = field(d, 'loopId');
		if (!id) return fail(400, { error: 'loopId missing.' });
		try {
			return json(await cycleHomeGantry(user, id, field(d, 'before')));
		} catch (err) {
			return failFrom(err);
		}
	},

	// The arm MOVES (grab animation). The page's Playback helper polls ?/playback and settles.
	cycleGrab: async (ev) => {
		const { d, user } = await writer(ev);
		const id = field(d, 'loopId');
		if (!id) return fail(400, { error: 'loopId missing.' });
		try {
			return json(await cycleGrab(user, id));
		} catch (err) {
			return failFrom(err);
		}
	},

	cycleGrabDone: async (ev) => {
		const { d, user } = await writer(ev);
		const id = field(d, 'loopId');
		if (!id) return fail(400, { error: 'loopId missing.' });
		try {
			return { loop: json(await cycleGrabDone(user, id)) };
		} catch (err) {
			return failFrom(err);
		}
	},

	cycleScanned: async (ev) => {
		const { d, user } = await writer(ev);
		const id = field(d, 'loopId');
		if (!id) return fail(400, { error: 'loopId missing.' });
		try {
			return { loop: json(await cycleScanned(user, id, { sweepRunId: field(d, 'sweepRunId'), barcode: field(d, 'barcode') })) };
		} catch (err) {
			return failFrom(err);
		}
	},

	// The OT-2 fills the cart: a one-cart WaxFillingRun started on the robot's current wax protocol.
	cycleFill: async (ev) => {
		const { d, user } = await writer(ev, true);
		const id = field(d, 'loopId');
		if (!id) return fail(400, { error: 'loopId missing.' });
		try {
			return json(await cycleFill(user, id));
		} catch (err) {
			return failFrom(err);
		}
	},

	cycleFillDone: async (ev) => {
		const { d, user } = await writer(ev, true);
		const id = field(d, 'loopId');
		if (!id) return fail(400, { error: 'loopId missing.' });
		try {
			return { loop: json(await cycleFillDone(user, id, field(d, 'finalStatus'))) };
		} catch (err) {
			return failFrom(err);
		}
	},

	// The arm MOVES (withdraw animation).
	cycleWithdraw: async (ev) => {
		const { d, user } = await writer(ev);
		const id = field(d, 'loopId');
		if (!id) return fail(400, { error: 'loopId missing.' });
		try {
			return json(await cycleWithdraw(user, id));
		} catch (err) {
			return failFrom(err);
		}
	},

	cycleWithdrawDone: async (ev) => {
		const { d, user } = await writer(ev);
		const id = field(d, 'loopId');
		if (!id) return fail(400, { error: 'loopId missing.' });
		try {
			return json(await cycleWithdrawDone(user, id));
		} catch (err) {
			return failFrom(err);
		}
	},

	stopLoop: async (ev) => {
		const { d, user } = await writer(ev);
		const id = field(d, 'loopId');
		if (!id) return fail(400, { error: 'loopId missing.' });
		try {
			return json(await stopLoop(user, id));
		} catch (err) {
			return failFrom(err);
		}
	},

	// Force reset (the Robots board's "Reset"): end the running loop now, stopping the arm if it
	// moves; the page then forces the OT-2 back to idle over /api/opentrons-lab/robots/:id/force-reset.
	resetLoop: async (ev) => {
		const { user } = await writer(ev);
		try {
			return json(await resetLoop(user));
		} catch (err) {
			return failFrom(err);
		}
	},

	// A step failed in the browser (play refused, sweep errored, ...): record it and end the loop.
	failLoop: async (ev) => {
		const { d, user } = await writer(ev);
		const id = field(d, 'loopId');
		if (!id) return fail(400, { error: 'loopId missing.' });
		try {
			return { loop: json(await failLoop(user, id, field(d, 'step') ?? 'unknown', field(d, 'error') ?? 'failed')) };
		} catch (err) {
			return failFrom(err);
		}
	},

	// ── Stage Calibration ─────────────────────────────────────────────────────

	saveScanPosition: async (ev) => {
		const { d, user, robotId } = await stageWriter(ev);
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
		const { d, user, robotId } = await stageWriter(ev);
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
		const { d, user, robotId } = await stageWriter(ev);
		try {
			const r = await applyStageEdits(user, robotId, field(d, 'edits'), field(d, 'label'));
			return { applied: r.applied, failed: r.failed, mode: r.mode, calibration: json(r.calibration) };
		} catch (err) {
			return failFrom(err);
		}
	},

	// The tip end's live Z over a hole → depth below the taught rim.
	saveDispenseDepth: async (ev) => {
		const { d, user, robotId } = await stageWriter(ev);
		try {
			const c = await saveDispenseDepth(user, robotId, { z: field(d, 'z'), hasTip: field(d, 'hasTip') });
			return { success: `Dispense depth saved: ${Math.abs(Number(c.dispenseDepth?.mm))} mm ${Number(c.dispenseDepth?.mm) >= 0 ? 'below' : 'above'} the rim.`, calibration: json(c) };
		} catch (err) {
			return failFrom(err);
		}
	},

	saveStageGeometry: async (ev) => {
		const { d, user, robotId } = await stageWriter(ev);
		try {
			const c = await saveStageGeometry(user, robotId, { rotationDeg: field(d, 'rotationDeg'), jumpHeightMm: field(d, 'jumpHeightMm') });
			return { success: `Stage geometry saved: rotation ${c.stageRotationDeg}°, travel height ${c.stageJumpHeightMm} mm.`, calibration: json(c) };
		} catch (err) {
			return failFrom(err);
		}
	},

	// This robot's tip-calibrator fixture (robot-keyed — the arm's OT-2 has no deck).
	saveCalibrator: async (ev) => {
		const { d, user, robotId } = await stageWriter(ev);
		try {
			const r = await saveStageCalibrator(user, robotId, {
				x: field(d, 'x'),
				y: field(d, 'y'),
				z: field(d, 'z'),
				zCalWax: field(d, 'zCalWax'),
				maxTipAdjust: field(d, 'maxTipAdjust')
			});
			return { success: `Tip calibrator saved: approach (${r.position.x}, ${r.position.y}, ${r.position.z}), probe Z ${r.zCalWax}${r.maxTipAdjust != null ? `, max adjust ${r.maxTipAdjust}` : ''}.`, calibrator: r };
		} catch (err) {
			return failFrom(err);
		}
	}
};
