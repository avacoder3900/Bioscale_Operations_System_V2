/**
 * Robot Arm — Animate (ARM-06): poses by hand, move sets, sequences.
 *
 * This page is the library and the capture flow; the editors live under
 * ./moveset/[id] and ./sequence/[id]. Every arm-moving action confirms in
 * the browser first; the server refuses while a session owns the arm.
 */
import { fail, redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { deriveArmHolder } from '$lib/server/robot-arm-lock';
import {
	createMoveSet,
	createSequence,
	goToPose,
	holdArm,
	listMoveSets,
	listPoses,
	listSequences,
	playMoveSet,
	playSequence,
	playbackActive,
	poseByHand,
	readArm,
	recapturePose,
	savePoseFromArm,
	savePoseFromLeader,
	setMoveSetArchived,
	setPoseArchived,
	setSequenceArchived,
	startLeaderPosing,
	stopLeaderPosing,
	stopPlayback,
	updatePose,
	AnimateError
} from '$lib/server/robot-arm-animation';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');

	// The Pi's servo driver is not thread-safe and a running session owns the
	// bus, so the follower is only read when nothing is running.
	const active = await playbackActive().catch(() => null);
	const [poses, moveSets, sequences, arm, holder] = await Promise.all([
		listPoses().catch(() => null),
		listMoveSets().catch(() => null),
		listSequences().catch(() => null),
		active
			? Promise.resolve({ error: active.kind === 'teleop' ? 'not read while the follower is following the control arm' : `not read while a ${active.kind} session is running` })
			: readArm().catch((e) => ({ error: (e as Error).message })),
		deriveArmHolder().catch(() => null)
	]);

	return {
		poses: JSON.parse(JSON.stringify(poses ?? [])),
		moveSets: JSON.parse(JSON.stringify(moveSets ?? [])),
		sequences: JSON.parse(JSON.stringify(sequences ?? [])),
		libraryError: poses && moveSets && sequences ? null : 'Could not read the animation library.',
		armNow: 'error' in arm ? null : JSON.parse(JSON.stringify(arm)),
		armNowError: 'error' in arm ? arm.error : null,
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

function failFrom(err: unknown, scope: string) {
	const e = err as AnimateError;
	return fail(e instanceof AnimateError ? e.status : 400, { error: e.message, scope });
}

export const actions: Actions = {
	// The follower tracks the control (leader) arm under torque: no sag, no jump.
	poseWithLeader: async ({ locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		try {
			const r = await startLeaderPosing(who(locals));
			return { success: 'The follower is following the control arm. Move it into a pose, name it and press Save pose; press Done when finished.', leaderRunId: r.runId, scope: 'capture' };
		} catch (err) {
			return failFrom(err, 'capture');
		}
	},

	// Pause the follower where the control arm put it, read it, save, follow again.
	saveLeaderPose: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		const d = await request.formData();
		try {
			const r = await savePoseFromLeader(who(locals), { name: field(d, 'name'), notes: field(d, 'notes'), resume: field(d, 'resume') !== '0' });
			return {
				success: `Pose "${r.pose.name}" saved.${r.resumed ? ' Following the control arm again — move it to the next pose.' : ''}`,
				warning: r.warning,
				scope: 'capture'
			};
		} catch (err) {
			return failFrom(err, 'capture');
		}
	},

	// Done posing: the follower holds its last pose under torque; the control arm stays limp.
	stopLeaderPosing: async ({ locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		try {
			const r = await stopLeaderPosing(who(locals));
			return { success: r.stoppedRunId ? 'Done. The follower is holding its last pose; the control arm is limp.' : 'The follower was not following the control arm.', scope: 'capture' };
		} catch (err) {
			return failFrom(err, 'capture');
		}
	},

	// Torque OFF so the operator can move the arm. The arm sags.
	poseByHand: async ({ locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		try {
			const arm = await poseByHand(who(locals));
			return { posing: true, armNow: arm, scope: 'capture' };
		} catch (err) {
			return failFrom(err, 'capture');
		}
	},

	// Read the encoders into a new pose; torque back on (no jump) when it was off.
	savePose: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		const d = await request.formData();
		try {
			const r = await savePoseFromArm(who(locals), { name: field(d, 'name'), notes: field(d, 'notes'), hold: field(d, 'hold') === '1' });
			const held = r.hold ? (r.hold.held ? ' Torque is back on; the arm is holding the pose.' : '') : '';
			return {
				success: `Pose "${r.pose.name}" saved.${held}`,
				warning: r.hold && !r.hold.held ? r.hold.error : null,
				posing: !!r.hold && !r.hold.held,
				scope: 'capture'
			};
		} catch (err) {
			return failFrom(err, 'capture');
		}
	},

	// Torque back on where the arm is, with no jump.
	holdArm: async ({ locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		try {
			const r = await holdArm(who(locals));
			return r.held ? { success: 'Torque is on — the arm is holding its position.', posing: false, scope: 'capture' } : { warning: r.error, posing: true, scope: 'capture' };
		} catch (err) {
			return failFrom(err, 'capture');
		}
	},

	updatePose: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		const d = await request.formData();
		const id = field(d, 'id');
		if (!id) return fail(400, { error: 'Pose id missing.', scope: 'poses' });
		try {
			const p = await updatePose(who(locals), id, { name: field(d, 'name'), notes: field(d, 'notes'), fromArm: field(d, 'fromArm') === '1' });
			return { success: `Pose "${p.name}" updated${field(d, 'fromArm') === '1' ? ' from the arm' : ''}.`, scope: 'poses' };
		} catch (err) {
			return failFrom(err, 'poses');
		}
	},

	// End of a jog: the pose becomes where the arm is now (name/notes kept, trim cleared).
	savePoseFromJog: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		const id = field(await request.formData(), 'id');
		if (!id) return fail(400, { error: 'Pose id missing.', scope: 'jog' });
		try {
			const r = await recapturePose(who(locals), id);
			const changed = r.moved.map((m, i) => (m ? `J${i + 1} ${m > 0 ? '+' : ''}${m}` : null)).filter(Boolean);
			return { success: `Pose "${r.pose.name}" updated from the arm${changed.length ? ` (${changed.join(', ')})` : ' (unchanged)'}.`, scope: 'jog' };
		} catch (err) {
			return failFrom(err, 'jog');
		}
	},

	archivePose: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		const d = await request.formData();
		const id = field(d, 'id');
		if (!id) return fail(400, { error: 'Pose id missing.', scope: 'poses' });
		try {
			await setPoseArchived(who(locals), id, field(d, 'restore') !== '1');
			return { success: field(d, 'restore') === '1' ? 'Pose restored.' : 'Pose archived. Move sets that use it keep working.', scope: 'poses' };
		} catch (err) {
			return failFrom(err, 'poses');
		}
	},

	// The arm MOVES.
	goToPose: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		const id = field(await request.formData(), 'id');
		if (!id) return fail(400, { error: 'Pose id missing.', scope: 'poses' });
		try {
			const r = await goToPose(who(locals), id);
			const worst = Math.max(...r.residual.map(Math.abs));
			return { success: `At the pose (${r.jogs} jog(s), worst servo ${worst} step(s) off).`, scope: 'poses' };
		} catch (err) {
			return failFrom(err, 'poses');
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
			return failFrom(err, 'moveSets');
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
			return failFrom(err, 'sequences');
		}
		redirect(303, `/manufacturing/cart-mfg/robot-arm/animate/sequence/${id}`);
	},

	archiveMoveSet: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		const d = await request.formData();
		const id = field(d, 'id');
		if (!id) return fail(400, { error: 'Move set id missing.', scope: 'moveSets' });
		try {
			await setMoveSetArchived(who(locals), id, field(d, 'restore') !== '1');
			return { success: field(d, 'restore') === '1' ? 'Move set restored.' : 'Move set archived.', scope: 'moveSets' };
		} catch (err) {
			return failFrom(err, 'moveSets');
		}
	},

	archiveSequence: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		const d = await request.formData();
		const id = field(d, 'id');
		if (!id) return fail(400, { error: 'Sequence id missing.', scope: 'sequences' });
		try {
			await setSequenceArchived(who(locals), id, field(d, 'restore') !== '1');
			return { success: field(d, 'restore') === '1' ? 'Sequence restored.' : 'Sequence archived.', scope: 'sequences' };
		} catch (err) {
			return failFrom(err, 'sequences');
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
			return failFrom(err, 'play');
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
			return failFrom(err, 'play');
		}
	},

	stop: async ({ locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		try {
			return { stop: await stopPlayback(who(locals)) };
		} catch (err) {
			return failFrom(err, 'play');
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
	}
};
