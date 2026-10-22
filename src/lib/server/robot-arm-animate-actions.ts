/**
 * Form actions shared by the Animate pages (the library and the move-set
 * editor both host the pose editor, Go to pose and playback). Each page
 * spreads these into its own `actions`. Every action checks the session and
 * `manufacturing:write` (`playback` only reads), and every failure comes back
 * as `fail(status, { error })`.
 */
import { fail, type RequestEvent } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import {
	afterPlay,
	createPose,
	goToPose,
	holdArm,
	playbackActive,
	setPosePositions,
	stopPlayback,
	AnimateError
} from '$lib/server/robot-arm-animation';
import { friendlyName } from '$lib/robot-arm/animation';

export function who(locals: App.Locals) {
	return { _id: locals.user!._id, username: locals.user!.username };
}

export function field(d: FormData, k: string): string | null {
	return d.get(k)?.toString() ?? null;
}

export function failFrom(err: unknown) {
	const e = err as AnimateError;
	return fail(e instanceof AnimateError ? e.status : 400, { error: e.message });
}

function positionsField(d: FormData): unknown {
	try {
		return JSON.parse(field(d, 'positions') ?? 'null');
	} catch {
		return null;
	}
}

type Ev = RequestEvent<any, any>;

function writer(locals: App.Locals) {
	if (!locals.user) return false;
	requirePermission(locals.user, 'manufacturing:write');
	return true;
}

export const sharedAnimateActions = {
	// A new pose from the sliders (goal pose); without positions, from the arm's encoders.
	createPose: async ({ request, locals }: Ev) => {
		if (!writer(locals)) return fail(401, { error: 'Unauthorized' });
		const d = await request.formData();
		try {
			const p = await createPose(who(locals), { name: field(d, 'name'), notes: field(d, 'notes'), positions: positionsField(d) ?? undefined });
			return { success: `Pose "${friendlyName(p.name)}" saved.`, createdPoseId: p._id };
		} catch (err) {
			return failFrom(err);
		}
	},

	// Save the sliders into an existing pose (it becomes a goal pose).
	savePosePositions: async ({ request, locals }: Ev) => {
		if (!writer(locals)) return fail(401, { error: 'Unauthorized' });
		const d = await request.formData();
		const id = field(d, 'id');
		if (!id) return fail(400, { error: 'Pose id missing.' });
		try {
			const r = await setPosePositions(who(locals), id, positionsField(d));
			return { success: `Pose "${friendlyName(r.pose.name)}" saved.` };
		} catch (err) {
			return failFrom(err);
		}
	},

	// Torque on: hold route if installed, else plain torque-on (servos return to their last goal).
	holdArm: async ({ locals }: Ev) => {
		if (!writer(locals)) return fail(401, { error: 'Unauthorized' });
		try {
			const r = await holdArm(who(locals));
			return r.held ? { success: 'Torque is on.' } : fail(502, { error: r.error ?? 'Torque is still off.' });
		} catch (err) {
			return failFrom(err);
		}
	},

	// The arm MOVES: a one-pose play from where it is. The page's playback poll takes it from here.
	goToPose: async ({ request, locals }: Ev) => {
		if (!writer(locals)) return fail(401, { error: 'Unauthorized' });
		const id = field(await request.formData(), 'id');
		if (!id) return fail(400, { error: 'Pose id missing.' });
		try {
			return { play: await goToPose(who(locals), id) };
		} catch (err) {
			return failFrom(err);
		}
	},

	stop: async ({ locals }: Ev) => {
		if (!writer(locals)) return fail(401, { error: 'Unauthorized' });
		try {
			return { stop: await stopPlayback(who(locals)) };
		} catch (err) {
			return failFrom(err);
		}
	},

	// Automatic, after a play / go-to ends on its own: torque back on; droop correction for captured poses.
	settle: async ({ request, locals }: Ev) => {
		if (!writer(locals)) return fail(401, { error: 'Unauthorized' });
		const runId = field(await request.formData(), 'runId');
		if (!runId) return fail(400, { error: 'No run.' });
		try {
			return { settle: JSON.parse(JSON.stringify(await afterPlay(who(locals), runId))) };
		} catch (err) {
			return failFrom(err);
		}
	},

	playback: async ({ locals }: Ev) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:read');
		try {
			return { active: await playbackActive() };
		} catch (err) {
			return fail(502, { error: (err as Error).message });
		}
	}
};
