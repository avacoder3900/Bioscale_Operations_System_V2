/** Robot Arm — Animate (ARM-06): the move-set editor. */
import { error, fail, redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { deriveArmHolder } from '$lib/server/robot-arm-lock';
import { clearPoseDroop, getMoveSet, goToMessage, goToPose, listPoses, playMoveSet, playbackActive, settleAfterPlay, saveToPi, setMoveSetArchived, stopPlayback, updateMoveSet, AnimateError } from '$lib/server/robot-arm-animation';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	const [moveSet, poses, active, holder] = await Promise.all([getMoveSet(params.id), listPoses(), playbackActive().catch(() => null), deriveArmHolder().catch(() => null)]);
	if (!moveSet) error(404, 'Move set not found');
	return {
		moveSet: JSON.parse(JSON.stringify(moveSet)),
		poses: JSON.parse(JSON.stringify(poses)),
		active,
		holder: JSON.parse(JSON.stringify(holder ?? null))
	};
};

function who(locals: App.Locals) {
	return { _id: locals.user!._id, username: locals.user!.username };
}
function field(d: FormData, k: string): string | null {
	return d.get(k)?.toString() ?? null;
}
function failFrom(err: unknown) {
	const e = err as AnimateError;
	return fail(e instanceof AnimateError ? e.status : 400, { error: e.message });
}

export const actions: Actions = {
	save: async ({ request, locals, params }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		const d = await request.formData();
		let keyframes: unknown;
		try {
			keyframes = JSON.parse(field(d, 'keyframes') ?? '[]');
		} catch {
			return fail(400, { error: 'Keyframes could not be read.' });
		}
		try {
			const m = await updateMoveSet(who(locals), params.id, { name: field(d, 'name'), notes: field(d, 'notes'), keyframes });
			return { success: `"${m.name}" saved with ${m.keyframes.length} pose(s).` };
		} catch (err) {
			return failFrom(err);
		}
	},

	// The arm MOVES.
	play: async ({ locals, params }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		try {
			return { play: await playMoveSet(who(locals), params.id) };
		} catch (err) {
			return failFrom(err);
		}
	},

	stop: async ({ locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		try {
			return { stop: await stopPlayback(who(locals)) };
		} catch (err) {
			return failFrom(err);
		}
	},

	// Automatic, after a play finishes on its own: the arm MOVES a few steps onto the last pose.
	settle: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		const runId = (await request.formData()).get('runId')?.toString();
		if (!runId) return fail(400, { error: 'No run.' });
		try {
			return { settle: await settleAfterPlay(who(locals), runId) };
		} catch (err) {
			return failFrom(err);
		}
	},

	playback: async ({ locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:read');
		try {
			return { active: await playbackActive() };
		} catch (err) {
			return fail(502, { error: (err as Error).message });
		}
	},

	// The arm MOVES (≤ ~1500 steps per servo, by jogs), then settles on the pose and learns its droop.
	goToPose: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		const id = field(await request.formData(), 'poseId');
		if (!id) return fail(400, { error: 'No pose.' });
		try {
			return { success: goToMessage(await goToPose(who(locals), id)) };
		} catch (err) {
			return failFrom(err);
		}
	},

	clearDroop: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		const id = field(await request.formData(), 'poseId');
		if (!id) return fail(400, { error: 'No pose.' });
		try {
			await clearPoseDroop(who(locals), id);
			return { success: 'Droop trim cleared.' };
		} catch (err) {
			return failFrom(err);
		}
	},

	saveToPi: async ({ request, locals, params }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		const d = await request.formData();
		try {
			const r = await saveToPi(who(locals), 'move_set', params.id, field(d, 'recordingName'));
			return { success: `Saved on the Pi as "${r.name}" (${r.frames} frames, ${r.durationS} s). Replay it from the Control tab.` };
		} catch (err) {
			return failFrom(err);
		}
	},

	archive: async ({ locals, params }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		try {
			await setMoveSetArchived(who(locals), params.id, true);
		} catch (err) {
			return failFrom(err);
		}
		redirect(303, '/manufacturing/cart-mfg/robot-arm/animate');
	}
};
