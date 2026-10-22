/**
 * Form actions shared by the Animate pages (the library and the move-set
 * editor both host the pose editor, Go to pose and playback). Each page
 * spreads these into its own `actions`. Every action checks the session and
 * `manufacturing:write` (`playback`, `poseCalibration` and `verifiedRun`
 * only read), and every failure comes back as `fail(status, { error })`.
 *
 * ARM-09 (verified poses) adds: a pose's camera reference (capture, check
 * without moving, tolerances, retire) and the verified run (start / next /
 * stop / read) — the page drives a run one `verifiedNext` at a time.
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
import {
	calibratePose,
	checkPose,
	getPoseCalibration,
	retirePoseCalibration,
	setPoseTolerances,
	startVerifiedRun,
	stopVerifiedRun,
	verifiedRunNext,
	getVerifiedRun
} from '$lib/server/robot-arm-verified';

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
	},

	// ── ARM-09: a pose's camera reference ──────────────────────────────────

	// One reference with its picture (the pages load the list without pictures).
	poseCalibration: async ({ request, locals }: Ev) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:read');
		const id = field(await request.formData(), 'id');
		if (!id) return fail(400, { error: 'No reference.' });
		try {
			const c = await getPoseCalibration(id);
			return c ? { poseCalibration: JSON.parse(JSON.stringify(c)) } : fail(404, { error: 'Reference not found.' });
		} catch (err) {
			return failFrom(err);
		}
	},

	// The arm must already be ON the pose (Go to pose first). No motion here.
	calibratePose: async ({ request, locals }: Ev) => {
		if (!writer(locals)) return fail(401, { error: 'Unauthorized' });
		const d = await request.formData();
		const poseId = field(d, 'poseId');
		const camera = field(d, 'camera');
		if (!poseId) return fail(400, { error: 'Pose id missing.' });
		if (!camera) return fail(400, { error: 'Pick a camera first.' });
		try {
			const r = await calibratePose(who(locals), { poseId, cameraName: camera, note: field(d, 'note') });
			return { success: `Reference captured for "${friendlyName(r.summary.poseName)}" (${r.summary.armTags} arm tag(s), ${r.summary.fixedTags} fixed).`, warning: r.warnings.length ? r.warnings.join(' ') : null, poseCalibration: JSON.parse(JSON.stringify(r.summary)) };
		} catch (err) {
			return failFrom(err);
		}
	},

	// No motion: residuals against the reference, so the tolerances can be set above the jitter.
	checkPose: async ({ request, locals }: Ev) => {
		if (!writer(locals)) return fail(401, { error: 'Unauthorized' });
		const d = await request.formData();
		const poseId = field(d, 'poseId');
		const camera = field(d, 'camera');
		if (!poseId || !camera) return fail(400, { error: 'Pose and camera are needed.' });
		try {
			return { poseCheck: JSON.parse(JSON.stringify(await checkPose(who(locals), { poseId, cameraName: camera }))) };
		} catch (err) {
			return failFrom(err);
		}
	},

	setPoseTolerances: async ({ request, locals }: Ev) => {
		if (!writer(locals)) return fail(401, { error: 'Unauthorized' });
		const d = await request.formData();
		const id = field(d, 'calibrationId');
		if (!id) return fail(400, { error: 'No reference.' });
		try {
			const t = await setPoseTolerances(who(locals), id, { positionMm: field(d, 'positionMm'), angleDeg: field(d, 'angleDeg'), steps: field(d, 'steps') });
			return { success: `Tolerances saved: ${t.positionMm} mm, ${t.angleDeg}°, ${t.steps} steps.`, tolerances: t };
		} catch (err) {
			return failFrom(err);
		}
	},

	retirePoseCalibration: async ({ request, locals }: Ev) => {
		if (!writer(locals)) return fail(401, { error: 'Unauthorized' });
		const id = field(await request.formData(), 'calibrationId');
		if (!id) return fail(400, { error: 'No reference.' });
		try {
			return (await retirePoseCalibration(who(locals), id)) ? { success: 'Reference retired. The pose is no longer verified until a new one is captured.' } : fail(404, { error: 'That reference was not active.' });
		} catch (err) {
			return failFrom(err);
		}
	},

	// ── ARM-09: verified run (the page calls next after every chunk) ───────

	verifiedStart: async ({ request, locals }: Ev) => {
		if (!writer(locals)) return fail(401, { error: 'Unauthorized' });
		const d = await request.formData();
		const kind = field(d, 'kind');
		const id = field(d, 'id');
		const camera = field(d, 'camera');
		if (kind !== 'move_set' && kind !== 'sequence' && kind !== 'pose') return fail(400, { error: 'What to play is missing.' });
		if (!id) return fail(400, { error: 'Id missing.' });
		if (!camera) return fail(400, { error: 'Pick a camera first.' });
		try {
			return { run: JSON.parse(JSON.stringify(await startVerifiedRun(who(locals), { kind, id, cameraName: camera }))) };
		} catch (err) {
			return failFrom(err);
		}
	},

	// The arm MOVES when the run's cursor is at "play".
	verifiedNext: async ({ request, locals }: Ev) => {
		if (!writer(locals)) return fail(401, { error: 'Unauthorized' });
		const id = field(await request.formData(), 'runId');
		if (!id) return fail(400, { error: 'No run.' });
		try {
			return { run: JSON.parse(JSON.stringify(await verifiedRunNext(who(locals), id))) };
		} catch (err) {
			return failFrom(err);
		}
	},

	verifiedStop: async ({ request, locals }: Ev) => {
		if (!writer(locals)) return fail(401, { error: 'Unauthorized' });
		const id = field(await request.formData(), 'runId');
		if (!id) return fail(400, { error: 'No run.' });
		try {
			const r = await stopVerifiedRun(who(locals), id);
			return { run: JSON.parse(JSON.stringify(r.run)), stop: { torqueOn: r.torqueOn, error: r.error } };
		} catch (err) {
			return failFrom(err);
		}
	},

	verifiedRun: async ({ request, locals }: Ev) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:read');
		const id = field(await request.formData(), 'runId');
		if (!id) return fail(400, { error: 'No run.' });
		try {
			return { run: JSON.parse(JSON.stringify(await getVerifiedRun(id, 'all'))) };
		} catch (err) {
			return failFrom(err);
		}
	}
};
