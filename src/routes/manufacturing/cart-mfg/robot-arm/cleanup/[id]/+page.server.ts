/**
 * Robot Arm — one recording clean-up (the step editor).
 *
 * The editor keeps the draft in the browser and sends the whole thing on
 * Save, so every action here is small. Nothing reads the serial bus on load:
 * the arm is only touched when the operator presses an arm button.
 */
import { error, fail, redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import {
	CleanupError,
	MAX_MOVE_STEPS,
	getCleanup,
	moveArm,
	readArm,
	resplitCleanup,
	saveCleanup,
	saveToPi
} from '$lib/server/robot-arm-cleanup';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	const cleanup = await getCleanup(params.id);
	if (!cleanup) error(404, 'Clean-up not found');
	return { cleanup, maxMoveSteps: MAX_MOVE_STEPS };
};

function failed(err: unknown) {
	if (err instanceof CleanupError) return fail(err.status, { error: err.message });
	throw err;
}

export const actions: Actions = {
	save: async ({ request, locals, params }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		const data = await request.formData();
		try {
			const draft = await saveCleanup(locals.user, params.id, data.get('payload')?.toString() ?? '');
			return { saved: true, steps: draft.steps.length };
		} catch (err) {
			return failed(err);
		}
	},

	resplit: async ({ request, locals, params }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		const data = await request.formData();
		try {
			const steps = await resplitCleanup(locals.user, params.id, {
				thresholdSteps: data.get('thresholdSteps')?.toString() ?? '',
				pauseS: data.get('pauseS')?.toString() ?? ''
			});
			return { resplit: true, steps };
		} catch (err) {
			return failed(err);
		}
	},

	readArm: async ({ locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:read');
		try {
			const { positions } = await readArm();
			return { arm: positions };
		} catch (err) {
			return failed(err);
		}
	},

	moveArm: async ({ request, locals, params }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		const data = await request.formData();
		let targets: Record<string, number>;
		try {
			targets = JSON.parse(data.get('targets')?.toString() ?? '{}');
		} catch {
			return fail(400, { error: 'Bad targets.' });
		}
		try {
			const moved = await moveArm(locals.user, params.id, data.get('label')?.toString() ?? '', targets);
			return { moved };
		} catch (err) {
			return failed(err);
		}
	},

	saveToPi: async ({ request, locals, params }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		const data = await request.formData();
		try {
			// Save the editor's current state first, so the Pi gets what is on screen.
			const payload = data.get('payload')?.toString();
			if (payload) await saveCleanup(locals.user, params.id, payload);
			const savedAs = await saveToPi(locals.user, params.id, data.get('name')?.toString() ?? '');
			return { saved: true, savedAs };
		} catch (err) {
			return failed(err);
		}
	}
};
