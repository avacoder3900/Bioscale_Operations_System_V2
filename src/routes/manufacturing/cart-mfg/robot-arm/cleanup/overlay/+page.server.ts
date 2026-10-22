/**
 * Robot Arm — Clean-up tab: overlay a pilot's recording on an animated one.
 *
 * ?smooth=<animated recording>&precise=<teleop recording> previews the
 * overlay; the settings live in the browser. Saving (to the Pi, or as a
 * clean-up draft) sends the names and settings back and the server
 * recomputes from the Pi. Nothing here touches the arm.
 */
import { fail, redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { CleanupError } from '$lib/server/robot-arm-cleanup';
import { listRecordingChoices, overlayToCleanup, previewOverlay, saveOverlayToPi, type OverlayPreview } from '$lib/server/robot-arm-overlay';
import { DEFAULT_PAUSE_S } from '$lib/robot-arm/recording-steps';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	const smooth = url.searchParams.get('smooth') ?? '';
	const precise = url.searchParams.get('precise') ?? '';
	const choices = await listRecordingChoices();
	let overlay: OverlayPreview | null = null;
	let overlayError: string | null = null;
	if (smooth && precise) {
		try {
			overlay = await previewOverlay(smooth, precise);
		} catch (err) {
			if (err instanceof CleanupError) overlayError = err.message;
			else throw err;
		}
	}
	return {
		recordings: choices.recordings,
		recordingsError: choices.error,
		picked: { smooth, precise },
		overlay,
		overlayError,
		defaults: { thresholdSteps: 10, pauseS: DEFAULT_PAUSE_S }
	};
};

function failed(err: unknown) {
	if (err instanceof CleanupError) return fail(err.status, { error: err.message });
	throw err;
}

export const actions: Actions = {
	saveToPi: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		const data = await request.formData();
		try {
			const saved = await saveOverlayToPi(locals.user, {
				smoothName: data.get('smooth')?.toString() ?? '',
				preciseName: data.get('precise')?.toString() ?? '',
				options: data.get('options')?.toString() ?? '',
				name: data.get('name')?.toString() ?? ''
			});
			return { saved };
		} catch (err) {
			return failed(err);
		}
	},

	toCleanup: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		const data = await request.formData();
		let id: string;
		try {
			id = await overlayToCleanup(locals.user, {
				smoothName: data.get('smooth')?.toString() ?? '',
				preciseName: data.get('precise')?.toString() ?? '',
				options: data.get('options')?.toString() ?? '',
				thresholdSteps: data.get('thresholdSteps')?.toString() ?? '',
				pauseS: data.get('pauseS')?.toString() ?? ''
			});
		} catch (err) {
			return failed(err);
		}
		redirect(303, `/manufacturing/cart-mfg/robot-arm/cleanup/${id}`);
	}
};
