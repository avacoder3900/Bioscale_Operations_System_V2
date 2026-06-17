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

async function getRobot(robotId: string): Promise<RobotDoc> {
	await connectDB();
	const robot = (await OpentronsRobot.findById(robotId)
		.select('_id name ip port')
		.lean()) as RobotDoc | null;
	if (!robot) throw error(404, 'Robot not found');
	return robot;
}

async function robotPost(robot: RobotDoc, path: string, body: unknown, timeoutMs = 10_000) {
	try {
		const res = await fetch(`${robotBaseUrl(robot)}${path}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'opentrons-version': '*' },
			body: body === null ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs)
		});
		const data = await res.json().catch(() => null);
		return { ok: res.ok, status: res.status, body: data };
	} catch (e) {
		return { ok: false, status: 502, body: { error: (e as Error).message } };
	}
}

async function robotPatch(robot: RobotDoc, path: string, body: unknown, timeoutMs = 10_000) {
	try {
		const res = await fetch(`${robotBaseUrl(robot)}${path}`, {
			method: 'PATCH',
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

async function robotPut(robot: RobotDoc, path: string, body: unknown, timeoutMs = 10_000) {
	try {
		const res = await fetch(`${robotBaseUrl(robot)}${path}`, {
			method: 'PUT',
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

	async function safeGet<T>(path: string): Promise<T | null> {
		try {
			const res = await (client as any).GET(path, {});
			if (res.error !== undefined) return null;
			return res.data as T;
		} catch {
			return null;
		}
	}

	const [settings, resetOptions, errorRecovery, networking, systemTime] = await Promise.all([
		safeGet<any>('/settings'),
		safeGet<any>('/settings/reset/options'),
		safeGet<any>('/errorRecovery/settings'),
		safeGet<any>('/networking/status'),
		safeGet<any>('/system/time')
	]);

	return {
		robot: JSON.parse(JSON.stringify(robot)),
		online: settings !== null || networking !== null,
		settings: (settings as any)?.settings ?? [],
		resetOptions: (resetOptions as any)?.options ?? [],
		errorRecoveryEnabled: (errorRecovery as any)?.data?.enabled ?? null,
		networking: networking ?? null,
		systemTime: (systemTime as any)?.data?.systemTime ?? null
	};
};

export const actions: Actions = {
	updateSetting: async ({ params, request, locals }) => {
		requirePermission(locals.user, 'manufacturing:write');
		const robot = await getRobot(params.robotId);
		const form = await request.formData();
		const id = form.get('id')?.toString();
		const value = form.get('value')?.toString() === 'true';
		if (!id) return fail(400, { error: 'setting id required' });
		const res = await robotPost(robot, '/settings', { id, value });
		if (!res.ok) return fail(res.status, { error: 'Setting update failed', details: res.body });
		return { success: true, message: `${id} → ${value}` };
	},

	resetSettings: async ({ params, request, locals }) => {
		requirePermission(locals.user, 'manufacturing:write');
		const robot = await getRobot(params.robotId);
		const form = await request.formData();
		const categories = form.getAll('category').map((c) => c.toString()).filter(Boolean);
		if (categories.length === 0) return fail(400, { error: 'pick at least one category to reset' });
		const body: Record<string, boolean> = {};
		for (const c of categories) body[c] = true;
		const res = await robotPost(robot, '/settings/reset', body);
		if (!res.ok) return fail(res.status, { error: 'Reset failed', details: res.body });
		return { success: true, message: `Reset: ${categories.join(', ')}` };
	},

	errorRecovery: async ({ params, request, locals }) => {
		requirePermission(locals.user, 'manufacturing:write');
		const robot = await getRobot(params.robotId);
		const form = await request.formData();
		const enabled = form.get('enabled')?.toString() === 'true';
		const res = await robotPatch(robot, '/errorRecovery/settings', { data: { enabled } });
		if (!res.ok) return fail(res.status, { error: 'Error recovery toggle failed', details: res.body });
		return { success: true, message: `Error recovery ${enabled ? 'enabled' : 'disabled'}` };
	},

	systemTime: async ({ params, request, locals }) => {
		requirePermission(locals.user, 'manufacturing:write');
		const robot = await getRobot(params.robotId);
		const form = await request.formData();
		const iso = form.get('iso')?.toString() || new Date().toISOString();
		const res = await robotPut(robot, '/system/time', { data: { systemTime: iso } });
		if (!res.ok) return fail(res.status, { error: 'System time update failed', details: res.body });
		return { success: true, message: `System time set to ${iso}` };
	}
};
