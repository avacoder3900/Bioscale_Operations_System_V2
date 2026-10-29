/**
 * Robot Arm — Stage calibration: the robot-arm line's own calibration studio.
 *
 * The arm's OT-2 fills ONE cartridge on an elevated single-cart stage, so the
 * Deck Calibration Studio's 24-slot deck model does not apply. What is taught
 * here, per OT-2 (ArmWaxFillCalibration), is everything the stage protocol
 * (protocols/Wax_Filling_GEN7_ArmStage.py) needs:
 *
 *   scan position    where the gantry scanner reads the cart — taught with NO tip
 *   cart location    the rim of the cart's first wax hole — taught with a PROBED
 *                    tip, stored tip-neutral (live − that tip's calibrator adjust)
 *   dispense depth   how far below that rim the tip end sits when wax is
 *                    dispensed (negative = hover) → the protocol's dispense_depth
 *   stage geometry   the cart's rotation on the stage and the travel height
 *
 * All logic is in $lib/server/arm-wax-fill; this file maps form fields to it.
 */
import { fail, redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import {
	ArmWaxFillError,
	getSettings,
	loadStageCalibration,
	saveCartLocation,
	saveDispenseDepth,
	saveScanPosition,
	saveStageGeometry
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
			return { success: 'Cart location saved (tip-neutral).', calibration: json(c) };
		} catch (err) {
			return failFrom(err);
		}
	},

	// The tip end's live Z over a hole → depth below the taught rim.
	saveDispenseDepth: async (ev) => {
		const { d, user, robotId } = await writer(ev);
		try {
			const c = await saveDispenseDepth(user, robotId, { z: field(d, 'z'), hasTip: field(d, 'hasTip') });
			return { success: `Dispense depth saved: ${c.dispenseDepth?.mm} mm ${Number(c.dispenseDepth?.mm) >= 0 ? 'below' : 'above'} the rim.`, calibration: json(c) };
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
	}
};
