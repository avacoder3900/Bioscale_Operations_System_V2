/**
 * Robot Arm — landing page.
 * Reads registered arms, recent runs, dataset count, plus Pi state
 * (active session + on-disk recordings) so the page can host the
 * teleop/record/replay/stop actions directly.
 */
import { fail, redirect } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection';
import { RobotArm, RobotArmRun, RobotArmDataset } from '$lib/server/db/models';
import { requirePermission } from '$lib/server/permissions';
import { robotArm } from '$lib/server/robot-arm-client';
import type { Actions, PageServerLoad } from './$types';

async function safeActive() {
	try {
		const res = await robotArm.getActive();
		return res.active;
	} catch (err) {
		return { error: (err as Error).message };
	}
}

async function safeRecordings() {
	try {
		const res = await robotArm.listRecordings();
		return res.recordings;
	} catch {
		return [];
	}
}

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();

	const [arms, recentRuns, datasetCount, active, piRecordings] = await Promise.all([
		RobotArm.find({ isActive: true })
			.select('_id role serialNumber comPort modelName voltage firmwareVersion')
			.sort({ role: 1 })
			.lean(),
		RobotArmRun.find({})
			.select('_id runId type status startedAt endedAt triggeredBy parameters')
			.sort({ createdAt: -1 })
			.limit(10)
			.lean(),
		RobotArmDataset.countDocuments({}),
		safeActive(),
		safeRecordings()
	]);

	return {
		arms: JSON.parse(JSON.stringify(arms)),
		recentRuns: JSON.parse(JSON.stringify(recentRuns)),
		datasetCount,
		active,
		piRecordings
	};
};

export const actions: Actions = {
	startTeleop: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		const data = await request.formData();
		const rate = parseInt(data.get('rate_hz')?.toString() || '10', 10);
		const dur = data.get('duration_s')?.toString();
		try {
			const result = await robotArm.startTeleop({
				rate_hz: rate,
				duration_s: dur ? parseFloat(dur) : undefined,
				triggered_by: { _id: locals.user._id, username: locals.user.username }
			});
			return { success: 'teleop started', runId: result.run_id };
		} catch (err) {
			return fail(409, { error: (err as Error).message });
		}
	},

	startRecord: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		const data = await request.formData();
		const name = data.get('name')?.toString().trim();
		if (!name) return fail(400, { error: 'name is required' });
		const rate = parseInt(data.get('rate_hz')?.toString() || '10', 10);
		const dur = data.get('duration_s')?.toString();
		try {
			const result = await robotArm.startRecord({
				name,
				rate_hz: rate,
				duration_s: dur ? parseFloat(dur) : undefined,
				triggered_by: { _id: locals.user._id, username: locals.user.username }
			});
			return { success: `recording "${name}" started`, runId: result.run_id };
		} catch (err) {
			return fail(409, { error: (err as Error).message });
		}
	},

	startReplay: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		const data = await request.formData();
		const source = data.get('source')?.toString().trim();
		if (!source) return fail(400, { error: 'source recording is required' });
		const loops = parseInt(data.get('loops')?.toString() || '1', 10);
		try {
			const result = await robotArm.startReplay({
				source,
				loops,
				triggered_by: { _id: locals.user._id, username: locals.user.username }
			});
			return {
				success: `replay started (${loops} loop${loops === 1 ? '' : 's'})`,
				runId: result.run_id
			};
		} catch (err) {
			return fail(409, { error: (err as Error).message });
		}
	},

	stop: async ({ locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		try {
			const result = await robotArm.stop();
			return { success: `stop signal sent (${result.stopped_run_id ?? 'no active session'})` };
		} catch (err) {
			return fail(500, { error: (err as Error).message });
		}
	}
};
