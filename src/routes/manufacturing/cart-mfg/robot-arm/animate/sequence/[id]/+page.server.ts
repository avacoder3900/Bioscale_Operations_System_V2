/** Robot Arm — Animate (ARM-06): the sequence editor. */
import { error, fail, redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { deriveArmHolder } from '$lib/server/robot-arm-lock';
import { getSequence, listMoveSets, listPoses, playSequence, playbackActive, afterPlay, saveToPi, setSequenceArchived, stopPlayback, updateSequence, AnimateError } from '$lib/server/robot-arm-animation';
import { sharedAnimateActions } from '$lib/server/robot-arm-animate-actions';
import { activeVerifiedRun, listPoseCalibrations } from '$lib/server/robot-arm-verified';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	const [sequence, moveSets, poses, active, holder, poseCalibrations, verifiedRun] = await Promise.all([
		getSequence(params.id),
		listMoveSets(),
		listPoses(),
		playbackActive().catch(() => null),
		deriveArmHolder().catch(() => null),
		listPoseCalibrations().catch(() => []),
		activeVerifiedRun().catch(() => null)
	]);
	if (!sequence) error(404, 'Sequence not found');
	return {
		sequence: JSON.parse(JSON.stringify(sequence)),
		moveSets: JSON.parse(JSON.stringify(moveSets)),
		poses: JSON.parse(JSON.stringify(poses)),
		active,
		holder: JSON.parse(JSON.stringify(holder ?? null)),
		poseCalibrations: JSON.parse(JSON.stringify(poseCalibrations)),
		verifiedRun: JSON.parse(JSON.stringify(verifiedRun ?? null))
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
	// ARM-09 verified run actions (verifiedStart/Next/Stop/Run, pose references); this page's own play/stop/settle/playback below win.
	...sharedAnimateActions,

	save: async ({ request, locals, params }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		const d = await request.formData();
		let items: unknown;
		try {
			items = JSON.parse(field(d, 'items') ?? '[]');
		} catch {
			return fail(400, { error: 'Items could not be read.' });
		}
		try {
			const s = await updateSequence(who(locals), params.id, { name: field(d, 'name'), notes: field(d, 'notes'), items });
			return { success: `"${s.name}" saved with ${s.items.length} move set(s).` };
		} catch (err) {
			return failFrom(err);
		}
	},

	// The arm MOVES.
	play: async ({ locals, params }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		try {
			return { play: await playSequence(who(locals), params.id) };
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
			return { settle: JSON.parse(JSON.stringify(await afterPlay(who(locals), runId))) };
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

	saveToPi: async ({ request, locals, params }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		const d = await request.formData();
		try {
			const r = await saveToPi(who(locals), 'sequence', params.id, field(d, 'recordingName'));
			return { success: `Saved on the Pi as "${r.name}" (${r.frames} frames, ${r.durationS} s). Replay it from the Control tab or use it in a task.` };
		} catch (err) {
			return failFrom(err);
		}
	},

	archive: async ({ locals, params }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		try {
			await setSequenceArchived(who(locals), params.id, true);
		} catch (err) {
			return failFrom(err);
		}
		redirect(303, '/manufacturing/cart-mfg/robot-arm/animate');
	}
};
