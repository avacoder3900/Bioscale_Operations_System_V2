/**
 * Robot Arm — Wax fill: the arm feeds one cart at a time to an OT-2 running
 * the stage wax-filling protocol (Wax_Filling_GEN7_ArmStage.py). Setup
 * (robot; deck + deck position only for the legacy carriage protocol), the
 * grab / withdraw animations (chosen once, changed only on request) and the
 * loop itself. The stage calibration (scan position, tip-neutral cart
 * location, dispense depth, stage geometry) is taught on the sibling
 * stage-calibration route.
 *
 * The browser drives a cycle one action at a time: homeGantry → cycleGrab →
 * (playback poll, settle) → cycleGrabDone → scan over /api/scanner/sweep →
 * cycleScanned → cycleFill → (EmbeddedRunController) → cycleFillDone →
 * homeGantry → cycleWithdraw → (playback poll, settle) → cycleWithdrawDone,
 * and round again. A scan that fails takes the fail route instead:
 * cycleScanFailed (or cycleScanned finding a cart that cannot be filled) →
 * homeGantry → cycleFail → (playback poll, settle) → cycleFailDone, and the
 * loop ends. All logic is in $lib/server/arm-wax-fill; this file only maps
 * form fields to it.
 */
import { fail, redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { sharedAnimateActions } from '$lib/server/robot-arm-animate-actions';
import {
	ArmWaxFillError,
	cycleFail,
	cycleFailDone,
	cycleFill,
	cycleFillDone,
	cycleGrab,
	cycleGrabDone,
	cycleHomeGantry,
	cycleScanFailed,
	cycleScanned,
	cycleWithdraw,
	cycleWithdrawDone,
	addStageProtocolToLibrary,
	deployStageProtocol,
	failLoop,
	getLoop,
	haltHomeGantry,
	haltLoop,
	loadArmWaxFill,
	resetLoop,
	saveAnimations,
	saveSetup,
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
	const page = await loadArmWaxFill();
	return JSON.parse(JSON.stringify(page)) as typeof page;
};

const who = (locals: App.Locals) => ({ _id: locals.user!._id, username: locals.user!.username });
const field = (d: FormData, k: string) => d.get(k)?.toString() ?? null;

function failFrom(err: unknown) {
	if (err instanceof ArmWaxFillError) return fail(err.status, { error: err.message });
	console.error('[arm-wax-fill]', err);
	return fail(500, { error: err instanceof Error ? err.message : 'Unexpected error.' });
}

type Ev = { request: Request; locals: App.Locals };

/** manufacturing:write, plus waxFilling:write for the actions that create wax runs. */
async function writer({ request, locals }: Ev, wax = false) {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:write');
	if (wax) requirePermission(locals.user, 'waxFilling:write');
	return { d: await request.formData(), user: who(locals) };
}

const json = (v: unknown) => JSON.parse(JSON.stringify(v));

export const actions: Actions = {
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
			const s = await saveAnimations(user, { grab: field(d, 'grab'), withdraw: field(d, 'withdraw'), fail: field(d, 'fail') });
			return { success: `Animations saved: grab "${s.grabAnimation?.name}", withdraw "${s.withdrawAnimation?.name}", fail "${s.failAnimation?.name}".` };
		} catch (err) {
			return failFrom(err);
		}
	},

	// Put a stage protocol from the library on the arm's OT-2 — the production fill or the
	// p300 rehearsal — over the server line, and repoint the robot's wax-filling entry to it.
	// File a stage .py in the library as THE row for that file name (older rows of the
	// same name are archived), so the picker cannot offer a stale copy beside the new one.
	addToLibrary: async (ev) => {
		const { d, user } = await writer(ev);
		try {
			const f = d.get('file');
			if (!(f instanceof File)) return fail(400, { error: 'Pick a .py file.' });
			const r = await addStageProtocolToLibrary(user, { fileName: f.name, content: await f.text() });
			return {
				success:
					`${f.name} (file ${r.fileHash8}) is ${r.reused ? 'already' : 'now'} in the library` +
					`${r.archived.length ? `; ${r.archived.length} older cop${r.archived.length === 1 ? 'y' : 'ies'} of that file archived` : ''}. Pick it and Deploy to robot.`,
				libraryId: r.libraryId
			};
		} catch (err) {
			return failFrom(err);
		}
	},

	deployProtocol: async (ev) => {
		const { d, user } = await writer(ev);
		try {
			const r = await deployStageProtocol(user, field(d, 'libraryId'));
			return {
				success: `${r.protocol.protocolName} is now the wax-filling protocol on the robot${r.protocol.rehearsal ? ' — REHEARSAL: p300, air, no wax' : ''}.`,
				protocol: json(r.protocol)
			};
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

	// The scan read nothing: the cycle takes the fail route (fail animation, then the loop ends).
	cycleScanFailed: async (ev) => {
		const { d, user } = await writer(ev);
		const id = field(d, 'loopId');
		if (!id) return fail(400, { error: 'loopId missing.' });
		try {
			return { loop: json(await cycleScanFailed(user, id, { reason: field(d, 'reason'), sweepRunId: field(d, 'sweepRunId') })) };
		} catch (err) {
			return failFrom(err);
		}
	},

	// Fail route: the arm MOVES (fail animation) — after the gantry home, like grab and withdraw.
	cycleFail: async (ev) => {
		const { d, user } = await writer(ev);
		const id = field(d, 'loopId');
		if (!id) return fail(400, { error: 'loopId missing.' });
		try {
			return json(await cycleFail(user, id));
		} catch (err) {
			return failFrom(err);
		}
	},

	cycleFailDone: async (ev) => {
		const { d, user } = await writer(ev);
		const id = field(d, 'loopId');
		if (!id) return fail(400, { error: 'loopId missing.' });
		try {
			return { loop: json(await cycleFailDone(user, id)) };
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

	// STOP RUN: halt now whatever the step — the arm's play stops where it is, a fill is
	// cancelled, a scan's sweep is cancelled, the loop ends stopped. The page then calls
	// haltHomeGantry and, once the OT-2 confirms home, runs the arm's Return to home.
	haltLoop: async (ev) => {
		const { d, user } = await writer(ev, true);
		const id = field(d, 'loopId');
		if (!id) return fail(400, { error: 'loopId missing.' });
		try {
			return json(await haltLoop(user, id));
		} catch (err) {
			return failFrom(err);
		}
	},

	// After a halt: the OT-2 all the way home (waits for its run to finish stopping first).
	// Synchronous on the robot; refuses while the robot is still stopping.
	haltHomeGantry: async (ev) => {
		const { d, user } = await writer(ev);
		const id = field(d, 'loopId');
		if (!id) return fail(400, { error: 'loopId missing.' });
		try {
			return json(await haltHomeGantry(user, id));
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
	}
};
