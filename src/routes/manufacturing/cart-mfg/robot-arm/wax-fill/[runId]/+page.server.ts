/**
 * ARM-WAX-01 run console — one guarded action per state-machine step.
 *
 * Every action delegates to src/lib/server/arm-wax-fill.ts, which re-checks
 * live hardware state (arm session, OT-2 run status) before flipping the
 * phase. A TransitionError comes back as fail(400) with the reason.
 */
import { error, fail, redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, ArmWaxFillRun } from '$lib/server/db';
import {
	startArmLoad,
	confirmLoaded,
	startFill,
	confirmFilled,
	startArmUnload,
	completeRun,
	abortRun,
	TransitionError,
	ARM_LOAD_TASK,
	ARM_UNLOAD_TASK
} from '$lib/server/arm-wax-fill';
import { getRobot, robotGet, forwardResponse } from '$lib/server/opentrons/proxy';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();

	const run = await ArmWaxFillRun.findById(params.runId).lean();
	if (!run) error(404, 'Arm wax fill run not found');

	// In 'loaded' phase the operator picks which protocol on the robot to
	// play — fetch the robot's protocol list (tolerate robot being offline).
	let protocols: { id: string; name: string; createdAt?: string }[] = [];
	let protocolsError: string | null = null;
	if ((run as any).phase === 'loaded') {
		try {
			const robot = await getRobot((run as any).robotId);
			const res = await robotGet(robot, '/protocols');
			const { data } = await forwardResponse(res);
			protocols = (((data as any)?.data ?? []) as any[])
				.map((p) => ({
					id: p.id,
					name: p.metadata?.protocolName ?? p.files?.[0]?.name ?? p.id,
					createdAt: p.createdAt
				}))
				.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
		} catch (e) {
			protocolsError = e instanceof Error ? e.message : 'failed to list protocols';
		}
	}

	return {
		run: JSON.parse(JSON.stringify(run)),
		protocols,
		protocolsError,
		taskNames: { load: ARM_LOAD_TASK, unload: ARM_UNLOAD_TASK }
	};
};

function actor(locals: App.Locals) {
	return { _id: locals.user!._id, username: locals.user!.username };
}

async function guarded(fn: () => Promise<unknown>) {
	try {
		await fn();
		return { success: true };
	} catch (e) {
		if (e instanceof TransitionError) return fail(400, { error: e.message });
		return fail(500, { error: e instanceof Error ? e.message : 'unexpected error' });
	}
}

export const actions: Actions = {
	startLoad: async ({ locals, params }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		return guarded(() => startArmLoad(params.runId, actor(locals)));
	},
	confirmLoaded: async ({ locals, params }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		return guarded(() => confirmLoaded(params.runId, actor(locals)));
	},
	startFill: async ({ locals, params, request }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		const data = await request.formData();
		const protocolId = data.get('protocolId')?.toString();
		if (!protocolId) return fail(400, { error: 'Pick the ARM-WAX protocol on the robot' });
		return guarded(() => startFill(params.runId, protocolId, actor(locals)));
	},
	confirmFilled: async ({ locals, params }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		return guarded(() => confirmFilled(params.runId, actor(locals)));
	},
	startUnload: async ({ locals, params }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		return guarded(() => startArmUnload(params.runId, actor(locals)));
	},
	complete: async ({ locals, params }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		return guarded(() => completeRun(params.runId, actor(locals)));
	},
	abort: async ({ locals, params, request }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		const data = await request.formData();
		const reason = data.get('reason')?.toString() || 'operator abort';
		return guarded(() => abortRun(params.runId, reason, actor(locals)));
	}
};
