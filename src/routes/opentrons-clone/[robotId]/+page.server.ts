import { error, fail } from '@sveltejs/kit';
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

async function safeGet<T>(client: ReturnType<typeof createRobotClient>, path: string): Promise<T | null> {
	try {
		const res = await (client as any).GET(path, {});
		if (res.error !== undefined) return null;
		return res.data as T;
	} catch {
		return null;
	}
}

async function getRobot(robotId: string): Promise<RobotDoc> {
	await connectDB();
	const robot = (await OpentronsRobot.findById(robotId)
		.select('_id name ip port')
		.lean()) as RobotDoc | null;
	if (!robot) throw error(404, 'Robot not found');
	return robot;
}

async function robotPost(
	robot: RobotDoc,
	path: string,
	body: unknown,
	timeoutMs = 30_000
): Promise<{ ok: boolean; status: number; body?: unknown }> {
	try {
		const res = await fetch(`${robotBaseUrl(robot)}${path}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'opentrons-version': '*' },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs)
		});
		const data = await res.json().catch(() => null);
		return { ok: res.ok, status: res.status, body: data };
	} catch (e) {
		return { ok: false, status: 502, body: { error: (e as Error).message } };
	}
}

export const load: PageServerLoad = async ({ params }) => {
	const robot = await getRobot(params.robotId);

	const client = createRobotClient({ ip: robot.ip, port: robot.port }, { timeoutMs: 4000 });

	const [health, instruments, modules, calibrationStatus, pipetteOffsets, tipLengths, lights] =
		await Promise.all([
			safeGet<any>(client, '/health'),
			safeGet<any>(client, '/instruments'),
			safeGet<any>(client, '/modules'),
			safeGet<any>(client, '/calibration/status'),
			safeGet<any>(client, '/calibration/pipette_offset'),
			safeGet<any>(client, '/calibration/tip_length'),
			safeGet<any>(client, '/robot/lights')
		]);

	return {
		robot: JSON.parse(JSON.stringify(robot)),
		online: health !== null,
		health,
		instruments: instruments?.data ?? [],
		modules: modules?.data ?? [],
		calibrationStatus: calibrationStatus ?? null,
		pipetteOffsets: pipetteOffsets?.data ?? [],
		tipLengths: tipLengths?.data ?? [],
		lightsOn: (lights as any)?.on ?? false
	};
};

export const actions: Actions = {
	home: async ({ params, request, locals }) => {
		requirePermission(locals.user, 'manufacturing:write');
		const robot = await getRobot(params.robotId);
		const form = await request.formData();
		const target = form.get('target')?.toString() ?? 'robot';
		const body: Record<string, unknown> = { target };
		if (target === 'pipette') {
			const mount = form.get('mount')?.toString();
			if (mount === 'left' || mount === 'right') body.mount = mount;
			else return fail(400, { error: 'pipette target requires mount=left|right' });
		}
		const res = await robotPost(robot, '/robot/home', body, 60_000);
		if (!res.ok) return fail(res.status, { error: 'Home failed', details: res.body });
		return { success: true, message: `Homed ${target}${body.mount ? ` ${body.mount}` : ''}` };
	},

	lights: async ({ params, request, locals }) => {
		requirePermission(locals.user, 'manufacturing:write');
		const robot = await getRobot(params.robotId);
		const form = await request.formData();
		const on = form.get('on')?.toString() === 'true';
		const res = await robotPost(robot, '/robot/lights', { on }, 5_000);
		if (!res.ok) return fail(res.status, { error: 'Lights toggle failed', details: res.body });
		return { success: true, message: `Lights ${on ? 'on' : 'off'}` };
	},

	identify: async ({ params, request, locals }) => {
		requirePermission(locals.user, 'manufacturing:write');
		const robot = await getRobot(params.robotId);
		const form = await request.formData();
		const seconds = Math.min(Math.max(parseInt(form.get('seconds')?.toString() ?? '5', 10) || 5, 1), 30);
		const res = await robotPost(robot, `/identify?seconds=${seconds}`, null, 5_000);
		if (!res.ok) return fail(res.status, { error: 'Identify failed', details: res.body });
		return { success: true, message: `Identifying for ${seconds}s` };
	}
};
