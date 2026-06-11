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

export const load: PageServerLoad = async ({ params }) => {
	await connectDB();
	const robot = (await OpentronsRobot.findById(params.robotId)
		.select('_id name ip port')
		.lean()) as RobotDoc | null;
	if (!robot) throw error(404, 'Robot not found');

	const client = createRobotClient({ ip: robot.ip, port: robot.port }, { timeoutMs: 5000 });

	let offsets: any[] = [];
	let online = true;
	try {
		const res = await (client as any).GET('/labwareOffsets', {});
		if (res.error !== undefined) online = false;
		else offsets = res.data?.data ?? [];
	} catch {
		online = false;
	}

	return {
		robot: JSON.parse(JSON.stringify(robot)),
		online,
		offsets: JSON.parse(JSON.stringify(offsets))
	};
};
