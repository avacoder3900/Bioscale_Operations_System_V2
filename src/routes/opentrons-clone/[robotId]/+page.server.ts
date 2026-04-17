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

async function safeGet<T>(client: ReturnType<typeof createRobotClient>, path: string): Promise<T | null> {
	try {
		const res = await (client as any).GET(path, {});
		if (res.error !== undefined) return null;
		return res.data as T;
	} catch {
		return null;
	}
}

export const load: PageServerLoad = async ({ params }) => {
	await connectDB();
	const robot = (await OpentronsRobot.findById(params.robotId)
		.select('_id name ip port')
		.lean()) as RobotDoc | null;
	if (!robot) throw error(404, 'Robot not found');

	const client = createRobotClient({ ip: robot.ip, port: robot.port }, { timeoutMs: 4000 });

	const [health, instruments, modules, calibrationStatus, pipetteOffsets, tipLengths] =
		await Promise.all([
			safeGet<any>(client, '/health'),
			safeGet<any>(client, '/instruments'),
			safeGet<any>(client, '/modules'),
			safeGet<any>(client, '/calibration/status'),
			safeGet<any>(client, '/calibration/pipette_offset'),
			safeGet<any>(client, '/calibration/tip_length')
		]);

	return {
		robot: JSON.parse(JSON.stringify(robot)),
		online: health !== null,
		health,
		instruments: instruments?.data ?? [],
		modules: modules?.data ?? [],
		calibrationStatus: calibrationStatus ?? null,
		pipetteOffsets: pipetteOffsets?.data ?? [],
		tipLengths: tipLengths?.data ?? []
	};
};
