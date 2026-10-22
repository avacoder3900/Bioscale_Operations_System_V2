/** Robot Arm — Animate (ARM-06): the move-set editor (keyframes + the pose editor for the selected one). */
import { error, fail, redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { deriveArmHolder } from '$lib/server/robot-arm-lock';
import { clearPoseDroop, getMoveSet, listPoses, playMoveSet, playbackActive, readArm, saveToPi, setMoveSetArchived, updateMoveSet } from '$lib/server/robot-arm-animation';
import { failFrom, field, sharedAnimateActions, who } from '$lib/server/robot-arm-animate-actions';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	const [moveSet, poses, active, holder] = await Promise.all([getMoveSet(params.id), listPoses(), playbackActive().catch(() => null), deriveArmHolder().catch(() => null)]);
	if (!moveSet) error(404, 'Move set not found');
	// Never read the servo bus while a session owns it.
	const arm = active ? null : await readArm().catch(() => null);
	return {
		moveSet: JSON.parse(JSON.stringify(moveSet)),
		poses: JSON.parse(JSON.stringify(poses)),
		armNow: arm ? JSON.parse(JSON.stringify({ positions: arm.positions, temps: arm.temps, torqueOn: arm.torqueOn })) : null,
		active,
		holder: JSON.parse(JSON.stringify(holder ?? null))
	};
};

export const actions: Actions = {
	...sharedAnimateActions,

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
