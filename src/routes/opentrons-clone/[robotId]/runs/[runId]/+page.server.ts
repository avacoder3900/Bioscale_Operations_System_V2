import { error, fail, redirect } from '@sveltejs/kit';
import { connectDB, OpentronsRobot } from '$lib/server/db';
import { createRobotClient, robotBaseUrl } from '$lib/server/opentrons/client';
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad, Actions } from './$types';

interface RobotDoc {
	_id: string;
	name: string;
	ip: string;
	port?: number;
}

const VALID_ACTIONS = ['play', 'pause', 'stop', 'resume-from-recovery'] as const;
type ValidAction = (typeof VALID_ACTIONS)[number];

async function getRobot(robotId: string): Promise<RobotDoc> {
	await connectDB();
	const robot = (await OpentronsRobot.findById(robotId)
		.select('_id name ip port')
		.lean()) as RobotDoc | null;
	if (!robot) throw error(404, 'Robot not found');
	return robot;
}

export const load: PageServerLoad = async ({ params, url }) => {
	const robot = await getRobot(params.robotId);
	const client = createRobotClient({ ip: robot.ip, port: robot.port }, { timeoutMs: 5000 });
	const cmdLimit = Math.min(parseInt(url.searchParams.get('cmdLimit') ?? '50', 10), 200);

	let run: any = null;
	let currentState: any = null;
	let commands: any[] = [];
	let commandErrors: any[] = [];
	let online = true;

	try {
		const [runRes, stateRes, cmdRes, errRes] = await Promise.all([
			(client as any).GET('/runs/{runId}', { params: { path: { runId: params.runId } } }),
			(client as any).GET('/runs/{runId}/currentState', { params: { path: { runId: params.runId } } }),
			(client as any).GET('/runs/{runId}/commands', {
				params: { path: { runId: params.runId }, query: { pageLength: cmdLimit } }
			}),
			(client as any).GET('/runs/{runId}/commandErrors', {
				params: { path: { runId: params.runId } }
			})
		]);

		if (runRes.error !== undefined) {
			if (runRes.response.status === 404) throw error(404, 'Run not found');
			online = false;
		} else {
			run = runRes.data?.data ?? null;
		}
		if (stateRes.error === undefined) currentState = stateRes.data?.data ?? null;
		if (cmdRes.error === undefined) commands = cmdRes.data?.data ?? [];
		if (errRes.error === undefined) commandErrors = errRes.data?.data ?? [];
	} catch (e: any) {
		if (e?.status) throw e;
		online = false;
	}

	return {
		robot: JSON.parse(JSON.stringify(robot)),
		runId: params.runId,
		online,
		run: JSON.parse(JSON.stringify(run)),
		currentState: JSON.parse(JSON.stringify(currentState)),
		commands: JSON.parse(JSON.stringify(commands)),
		commandErrors: JSON.parse(JSON.stringify(commandErrors))
	};
};

export const actions: Actions = {
	action: async ({ params, request, locals }) => {
		requirePermission(locals.user, 'manufacturing:write');
		const robot = await getRobot(params.robotId);
		const form = await request.formData();
		const actionType = form.get('actionType')?.toString();
		if (!actionType || !VALID_ACTIONS.includes(actionType as ValidAction)) {
			return fail(400, { error: `Invalid actionType: ${actionType}` });
		}

		try {
			const res = await fetch(
				`${robotBaseUrl(robot)}/runs/${encodeURIComponent(params.runId as string)}/actions`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json', 'opentrons-version': '*' },
					body: JSON.stringify({ data: { actionType } }),
					signal: AbortSignal.timeout(10_000)
				}
			);
			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				return fail(res.status, { error: `Action ${actionType} failed`, details: err });
			}
			return { success: true, actionType };
		} catch (e) {
			return fail(502, { error: `Robot unreachable: ${(e as Error).message}` });
		}
	},

	delete: async ({ params, locals }) => {
		requirePermission(locals.user, 'manufacturing:write');
		const robot = await getRobot(params.robotId);
		try {
			const res = await fetch(
				`${robotBaseUrl(robot)}/runs/${encodeURIComponent(params.runId as string)}`,
				{
					method: 'DELETE',
					headers: { 'opentrons-version': '*' },
					signal: AbortSignal.timeout(10_000)
				}
			);
			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				return fail(res.status, { error: 'Delete failed', details: err });
			}
		} catch (e) {
			return fail(502, { error: `Robot unreachable: ${(e as Error).message}` });
		}
		throw redirect(303, `/opentrons-clone/${params.robotId}/runs`);
	}
};
