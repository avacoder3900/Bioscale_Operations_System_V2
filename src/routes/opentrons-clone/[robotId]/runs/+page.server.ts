import { error } from '@sveltejs/kit';
import { connectDB, OpentronsRobot } from '$lib/server/db';
import { createRobotClient } from '$lib/server/opentrons/client';
import type { PageServerLoad } from './$types';

interface RobotDoc {
	_id: string;
	name: string;
	ip: string;
	port?: number;
}

export const load: PageServerLoad = async ({ params, url }) => {
	await connectDB();
	const robot = (await OpentronsRobot.findById(params.robotId)
		.select('_id name ip port')
		.lean()) as RobotDoc | null;
	if (!robot) throw error(404, 'Robot not found');

	const pageLength = Math.min(parseInt(url.searchParams.get('limit') ?? '25', 10), 100);
	const client = createRobotClient({ ip: robot.ip, port: robot.port }, { timeoutMs: 5000 });

	let runs: any[] = [];
	let online = true;
	try {
		const res = await (client as any).GET('/runs', {
			params: { query: { pageLength } }
		});
		if (res.error !== undefined) online = false;
		else runs = res.data?.data ?? [];
	} catch {
		online = false;
	}

	runs.sort((a: any, b: any) => {
		const ta = new Date(a?.createdAt ?? 0).getTime();
		const tb = new Date(b?.createdAt ?? 0).getTime();
		return tb - ta;
	});

	return {
		robot: JSON.parse(JSON.stringify(robot)),
		online,
		runs: JSON.parse(JSON.stringify(runs))
	};
};
