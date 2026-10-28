/**
 * Robot Arm — Wax fill: the arm feeds one cart at a time to an OT-2 running
 * the ordinary wax-filling protocol. Setup (robot, deck, deck position), the
 * grab / withdraw animations (chosen once, changed only on request), the
 * two taught points (scan position, cart location) and the loop itself.
 *
 * The browser drives a cycle one action at a time: cycleGrab → (playback
 * poll, settle) → cycleGrabDone → scan over /api/scanner/sweep → cycleScanned
 * → cycleFill → (EmbeddedRunController) → cycleFillDone → cycleWithdraw →
 * (playback poll, settle) → cycleWithdrawDone, and round again. All logic is
 * in $lib/server/arm-wax-fill; this file only maps form fields to it.
 */
import { fail, redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { sharedAnimateActions } from '$lib/server/robot-arm-animate-actions';
import {
	ArmWaxFillError,
	cycleFill,
	cycleFillDone,
	cycleGrab,
	cycleGrabDone,
	cycleScanned,
	cycleWithdraw,
	cycleWithdrawDone,
	failLoop,
	getLoop,
	getSettings,
	loadArmWaxFill,
	saveAnimations,
	saveCartLocation,
	saveScanPosition,
	saveSetup,
	startLoop,
	stopLoop
} from '$lib/server/arm-wax-fill';
import type { Actions, PageServerLoad } from './$types';

// The fill step runs the whole OT-2 start (freshness gate, create, play) in one action.
export const config = { maxDuration: 60 };

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
			const s = await saveAnimations(user, { grab: field(d, 'grab'), withdraw: field(d, 'withdraw') });
			return { success: `Animations saved: grab "${s.grabAnimation?.name}", withdraw "${s.withdrawAnimation?.name}".` };
		} catch (err) {
			return failFrom(err);
		}
	},

	saveScanPosition: async (ev) => {
		const { d, user } = await writer(ev);
		try {
			const robotId = (await getSettings()).robotId ?? '';
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

	saveCartLocation: async (ev) => {
		const { d, user } = await writer(ev);
		try {
			const robotId = (await getSettings()).robotId ?? '';
			const c = await saveCartLocation(user, robotId, {
				x: field(d, 'x'),
				y: field(d, 'y'),
				z: field(d, 'z'),
				pipetteMount: field(d, 'pipetteMount'),
				pipetteName: field(d, 'pipetteName')
			});
			return { success: 'Cart location saved.', calibration: json(c) };
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
