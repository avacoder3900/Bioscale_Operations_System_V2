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

export const load: PageServerLoad = async ({ params }) => {
	const robot = await getRobot(params.robotId);
	const client = createRobotClient({ ip: robot.ip, port: robot.port }, { timeoutMs: 5000 });

	let dataFiles: any[] = [];
	let online = true;
	try {
		const res = await (client as any).GET('/dataFiles', {});
		if (res.error !== undefined) online = false;
		else dataFiles = res.data?.data ?? [];
	} catch {
		online = false;
	}

	return {
		robot: JSON.parse(JSON.stringify(robot)),
		online,
		dataFiles: JSON.parse(JSON.stringify(dataFiles))
	};
};

export const actions: Actions = {
	uploadDataFile: async ({ params, request, locals }) => {
		requirePermission(locals.user, 'manufacturing:write');
		const robot = await getRobot(params.robotId);
		const form = await request.formData();
		const file = form.get('file');
		if (!(file instanceof File) || file.size === 0) return fail(400, { error: 'file is required' });
		const out = new FormData();
		out.append('file', file, file.name);
		try {
			const res = await fetch(`${robotBaseUrl(robot)}/dataFiles`, {
				method: 'POST',
				headers: { 'opentrons-version': '*' },
				body: out,
				signal: AbortSignal.timeout(60_000)
			});
			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				return fail(res.status, { error: 'Upload failed', details: err });
			}
			return { success: true, message: `Uploaded ${file.name}` };
		} catch (e) {
			return fail(502, { error: `Robot unreachable: ${(e as Error).message}` });
		}
	},

	deleteDataFile: async ({ params, request, locals }) => {
		requirePermission(locals.user, 'manufacturing:write');
		const robot = await getRobot(params.robotId);
		const form = await request.formData();
		const id = form.get('id')?.toString();
		if (!id) return fail(400, { error: 'id required' });
		try {
			const res = await fetch(`${robotBaseUrl(robot)}/dataFiles/${encodeURIComponent(id)}`, {
				method: 'DELETE',
				headers: { 'opentrons-version': '*' },
				signal: AbortSignal.timeout(10_000)
			});
			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				return fail(res.status, { error: 'Delete failed', details: err });
			}
			return { success: true };
		} catch (e) {
			return fail(502, { error: `Robot unreachable: ${(e as Error).message}` });
		}
	},

	setClientData: async ({ params, request, locals }) => {
		requirePermission(locals.user, 'manufacturing:write');
		const robot = await getRobot(params.robotId);
		const form = await request.formData();
		const key = form.get('key')?.toString()?.trim();
		const valueRaw = form.get('value')?.toString() ?? '';
		if (!key) return fail(400, { error: 'key required' });
		let parsed: unknown;
		try {
			parsed = JSON.parse(valueRaw);
		} catch {
			return fail(400, { error: 'value must be valid JSON (object expected)' });
		}
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return fail(400, { error: 'value must be a JSON object (OT-2 /clientData requires a dict)' });
		}
		try {
			const res = await fetch(`${robotBaseUrl(robot)}/clientData/${encodeURIComponent(key)}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json', 'opentrons-version': '*' },
				body: JSON.stringify({ data: parsed }),
				signal: AbortSignal.timeout(5_000)
			});
			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				return fail(res.status, { error: 'Client data set failed', details: err });
			}
			return { success: true, message: `Set clientData[${key}]` };
		} catch (e) {
			return fail(502, { error: `Robot unreachable: ${(e as Error).message}` });
		}
	},

	deleteClientData: async ({ params, request, locals }) => {
		requirePermission(locals.user, 'manufacturing:write');
		const robot = await getRobot(params.robotId);
		const form = await request.formData();
		const key = form.get('key')?.toString()?.trim();
		const url = key
			? `${robotBaseUrl(robot)}/clientData/${encodeURIComponent(key)}`
			: `${robotBaseUrl(robot)}/clientData`;
		try {
			const res = await fetch(url, {
				method: 'DELETE',
				headers: { 'opentrons-version': '*' },
				signal: AbortSignal.timeout(5_000)
			});
			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				return fail(res.status, { error: 'Client data delete failed', details: err });
			}
			return { success: true, message: key ? `Deleted clientData[${key}]` : 'Cleared all clientData' };
		} catch (e) {
			return fail(502, { error: `Robot unreachable: ${(e as Error).message}` });
		}
	}
};
