/**
 * Robot Arm — Clean-up tab: pick a Pi recording and split it into steps.
 *
 * The split is the only automatic part of clean-up; everything after it is
 * the operator's, on ./[id]. Drafts live in Mongo, so this list works with
 * the Pi offline (only "new clean-up" needs the Pi, to read the recording).
 */
import { fail, redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { CleanupError, archiveCleanup, createCleanup, listCleanups } from '$lib/server/robot-arm-cleanup';
import { listRecordingChoices } from '$lib/server/robot-arm-overlay';
import { DEFAULT_PAUSE_S } from '$lib/robot-arm/recording-steps';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');

	// Recordings come labelled by what made them (teleop, Teach's Save To Pi, a
	// clean-up, an overlay), newest first; the page lists the teleop ones first.
	const [recordings, cleanups] = await Promise.all([listRecordingChoices(), listCleanups()]);
	return {
		recordings: recordings.recordings,
		recordingsError: recordings.error,
		cleanups,
		defaults: { thresholdSteps: 10, pauseS: DEFAULT_PAUSE_S }
	};
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		const data = await request.formData();
		let id: string;
		try {
			id = await createCleanup(locals.user, {
				sourceName: data.get('sourceName')?.toString() ?? '',
				thresholdSteps: data.get('thresholdSteps')?.toString() ?? '',
				pauseS: data.get('pauseS')?.toString() ?? '',
				smooth: data.get('smooth')?.toString() === 'on'
			});
		} catch (err) {
			if (err instanceof CleanupError) return fail(err.status, { error: err.message });
			throw err;
		}
		redirect(303, `/manufacturing/cart-mfg/robot-arm/maintenance/cleanup/${id}`);
	},

	archive: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		const data = await request.formData();
		try {
			await archiveCleanup(locals.user, data.get('id')?.toString() ?? '');
		} catch (err) {
			if (err instanceof CleanupError) return fail(err.status, { error: err.message });
			throw err;
		}
		return { success: 'Clean-up removed from the list. The recordings on the Pi are untouched.' };
	}
};
