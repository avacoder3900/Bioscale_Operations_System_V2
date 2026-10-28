/**
 * Robot Arm — Animate (ARM-06): the pose editor (live sliders), the control
 * arm, and the library of poses, move sets and sequences. The editors live
 * under ./moveset/[id] and ./sequence/[id]. Every arm-moving action confirms
 * in the browser first; the server refuses while a session owns the arm.
 * Pose / playback / torque actions are shared with the move-set editor
 * ($lib/server/robot-arm-animate-actions).
 */
import { fail, redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { deriveArmHolder } from '$lib/server/robot-arm-lock';
import {
	createMoveSet,
	createSequence,
	deleteArchivedPoses,
	listMoveSets,
	listPoses,
	listSequences,
	playMoveSet,
	playSequence,
	playbackActive,
	readArm,
	savePoseFromLeader,
	setMoveSetArchived,
	setPoseArchived,
	setPosesArchived,
	setSequenceArchived,
	solenoidStatus,
	startLeaderPosing,
	stopLeaderPosing,
	updatePose,
	type PoseBulkResult
} from '$lib/server/robot-arm-animation';
import { failFrom, field, sharedAnimateActions, who } from '$lib/server/robot-arm-animate-actions';
import { activeVerifiedRun, listPoseCalibrations } from '$lib/server/robot-arm-verified';
import { homeStepsByCamera } from '$lib/server/robot-arm-vision';
import { bulkPoseMessage, friendlyName } from '$lib/robot-arm/animation';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');

	// The Pi's servo driver is not thread-safe and a running session owns the
	// bus, so the follower is only read when nothing is running.
	const active = await playbackActive().catch(() => null);
	const [poses, moveSets, sequences, arm, holder, poseCalibrations, verifiedRun, solenoids] = await Promise.all([
		listPoses().catch(() => null),
		listMoveSets().catch(() => null),
		listSequences().catch(() => null),
		active
			? Promise.resolve({ error: active.kind === 'teleop' ? 'not read while the follower is following the control arm' : `not read while a ${active.kind} session is running` })
			: readArm().catch((e) => ({ error: (e as Error).message })),
		deriveArmHolder().catch(() => null),
		// ARM-09: every pose's active camera reference (no pictures) and a verified run still in progress (page reload resumes it).
		listPoseCalibrations().catch(() => []),
		activeVerifiedRun().catch(() => null),
		// The trapdoor solenoids (GPIO, not the servo bus — fine to read mid-play).
		solenoidStatus()
	]);
	// Home per camera (Vision tab calibration): the pose editor's default reference marker.
	const homeSteps = await homeStepsByCamera().catch(() => ({}));

	return {
		poses: JSON.parse(JSON.stringify(poses ?? [])),
		moveSets: JSON.parse(JSON.stringify(moveSets ?? [])),
		sequences: JSON.parse(JSON.stringify(sequences ?? [])),
		libraryError: poses && moveSets && sequences ? null : 'Could not read the animation library.',
		armNow: 'error' in arm ? null : JSON.parse(JSON.stringify({ positions: arm.positions, temps: arm.temps, torqueOn: arm.torqueOn })),
		armNowError: 'error' in arm ? arm.error : null,
		active,
		holder: JSON.parse(JSON.stringify(holder ?? null)),
		poseCalibrations: JSON.parse(JSON.stringify(poseCalibrations)),
		verifiedRun: JSON.parse(JSON.stringify(verifiedRun ?? null)),
		solenoids: JSON.parse(JSON.stringify(solenoids)),
		homeSteps
	};
};

/** Nothing done → an error; some skipped → a warning; else success. */
function bulkFlash(verb: string, r: PoseBulkResult) {
	const message = bulkPoseMessage(verb, r.done.length, r.skipped);
	if (!r.done.length && r.skipped.length) return fail(409, { error: message });
	return r.skipped.length ? { warning: message } : { success: message };
}

export const actions: Actions = {
	...sharedAnimateActions,

	// The follower tracks the control (leader) arm under torque — quick rough posing.
	poseWithLeader: async ({ locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		try {
			await startLeaderPosing(who(locals));
			return { success: 'Following the control arm. Move it into a pose, name it and press Save; Done when finished.' };
		} catch (err) {
			return failFrom(err);
		}
	},

	// Stop following (torque straight back on), read the follower, save, follow again.
	saveLeaderPose: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		const d = await request.formData();
		try {
			const r = await savePoseFromLeader(who(locals), { name: field(d, 'name'), notes: field(d, 'notes'), resume: field(d, 'resume') !== '0' });
			return { success: `Pose "${friendlyName(r.pose.name)}" saved.`, warning: r.warning };
		} catch (err) {
			return failFrom(err);
		}
	},

	// Done: the follower keeps holding its last pose (torque on); the control arm stays limp.
	stopLeaderPosing: async ({ locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		try {
			const r = await stopLeaderPosing(who(locals));
			if (!r.torqueOn) return { warning: `Stopped following, but torque could not be turned back on (${r.error}). The arm may be limp — press Torque on.` };
			return { success: 'Done. The follower is holding its last pose.' };
		} catch (err) {
			return failFrom(err);
		}
	},

	renamePose: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		const d = await request.formData();
		const id = field(d, 'id');
		if (!id) return fail(400, { error: 'Pose id missing.' });
		try {
			const p = await updatePose(who(locals), id, { name: field(d, 'name'), notes: field(d, 'notes') });
			return { success: `Renamed to "${p.name}".` };
		} catch (err) {
			return failFrom(err);
		}
	},

	archivePose: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		const d = await request.formData();
		const id = field(d, 'id');
		if (!id) return fail(400, { error: 'Pose id missing.' });
		try {
			await setPoseArchived(who(locals), id, field(d, 'restore') !== '1');
			return { success: field(d, 'restore') === '1' ? 'Pose restored.' : 'Pose archived. Move sets that use it keep working.' };
		} catch (err) {
			return failFrom(err);
		}
	},

	// The pose library's Select mode: many `id` fields at once.
	archivePoses: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		const d = await request.formData();
		const restore = field(d, 'restore') === '1';
		try {
			return bulkFlash(restore ? 'Restored' : 'Archived', await setPosesArchived(who(locals), d.getAll('id'), !restore));
		} catch (err) {
			return failFrom(err);
		}
	},

	// For good: archived poses no move set uses. The browser confirms first.
	deletePoses: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		const d = await request.formData();
		try {
			return bulkFlash('Deleted', await deleteArchivedPoses(who(locals), d.getAll('id')));
		} catch (err) {
			return failFrom(err);
		}
	},

	createMoveSet: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		const d = await request.formData();
		let id: string;
		try {
			id = (await createMoveSet(who(locals), { name: field(d, 'name') }))._id;
		} catch (err) {
			return failFrom(err);
		}
		redirect(303, `/manufacturing/cart-mfg/robot-arm/animate/moveset/${id}`);
	},

	createSequence: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		const d = await request.formData();
		let id: string;
		try {
			id = (await createSequence(who(locals), { name: field(d, 'name') }))._id;
		} catch (err) {
			return failFrom(err);
		}
		redirect(303, `/manufacturing/cart-mfg/robot-arm/animate/sequence/${id}`);
	},

	archiveMoveSet: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		const d = await request.formData();
		const id = field(d, 'id');
		if (!id) return fail(400, { error: 'Move set id missing.' });
		try {
			await setMoveSetArchived(who(locals), id, field(d, 'restore') !== '1');
			return { success: field(d, 'restore') === '1' ? 'Move set restored.' : 'Move set archived.' };
		} catch (err) {
			return failFrom(err);
		}
	},

	archiveSequence: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		const d = await request.formData();
		const id = field(d, 'id');
		if (!id) return fail(400, { error: 'Sequence id missing.' });
		try {
			await setSequenceArchived(who(locals), id, field(d, 'restore') !== '1');
			return { success: field(d, 'restore') === '1' ? 'Sequence restored.' : 'Sequence archived.' };
		} catch (err) {
			return failFrom(err);
		}
	},

	// The arm MOVES: from wherever it is, through the whole move set / sequence.
	playMoveSet: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		const id = field(await request.formData(), 'id');
		if (!id) return fail(400, { error: 'Move set id missing.' });
		try {
			return { play: await playMoveSet(who(locals), id) };
		} catch (err) {
			return failFrom(err);
		}
	},

	playSequence: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		const id = field(await request.formData(), 'id');
		if (!id) return fail(400, { error: 'Sequence id missing.' });
		try {
			return { play: await playSequence(who(locals), id) };
		} catch (err) {
			return failFrom(err);
		}
	}
};
