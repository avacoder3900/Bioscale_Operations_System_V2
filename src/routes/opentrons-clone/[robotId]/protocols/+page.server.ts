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

	let protocols: any[] = [];
	let online = true;
	try {
		const res = await (client as any).GET('/protocols', {});
		if (res.error !== undefined) online = false;
		else protocols = res.data?.data ?? [];
	} catch {
		online = false;
	}

	// Newest upload first
	protocols.sort((a: any, b: any) => {
		const ta = new Date(a?.createdAt ?? 0).getTime();
		const tb = new Date(b?.createdAt ?? 0).getTime();
		return tb - ta;
	});

	return {
		robot: JSON.parse(JSON.stringify(robot)),
		online,
		protocols: JSON.parse(JSON.stringify(protocols))
	};
};

export const actions: Actions = {
	upload: async ({ params, request, locals }) => {
		requirePermission(locals.user, 'manufacturing:write');
		const robot = await getRobot(params.robotId);

		const form = await request.formData();
		const mainFile = form.get('protocol');
		if (!(mainFile instanceof File) || mainFile.size === 0) {
			return fail(400, { error: 'Protocol file is required' });
		}

		const supportFiles = form.getAll('support').filter((f) => f instanceof File && f.size > 0) as File[];

		const robotForm = new FormData();
		robotForm.append('files', mainFile, mainFile.name);
		for (const sf of supportFiles) robotForm.append('files', sf, sf.name);

		try {
			const res = await fetch(`${robotBaseUrl(robot)}/protocols`, {
				method: 'POST',
				headers: { 'opentrons-version': '*' },
				body: robotForm,
				signal: AbortSignal.timeout(60_000)
			});
			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				return fail(res.status, { error: 'Upload failed', details: err });
			}
			const data = await res.json();
			return { success: true, protocolId: data?.data?.id ?? null };
		} catch (e) {
			return fail(502, { error: `Robot unreachable: ${(e as Error).message}` });
		}
	},

	delete: async ({ params, request, locals }) => {
		requirePermission(locals.user, 'manufacturing:write');
		const robot = await getRobot(params.robotId);
		const form = await request.formData();
		const protocolId = form.get('protocolId')?.toString();
		if (!protocolId) return fail(400, { error: 'protocolId required' });

		try {
			const res = await fetch(`${robotBaseUrl(robot)}/protocols/${encodeURIComponent(protocolId)}`, {
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
	}
};
