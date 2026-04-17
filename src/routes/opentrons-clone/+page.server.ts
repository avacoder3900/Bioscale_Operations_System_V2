import { connectDB, OpentronsRobot } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	await connectDB();
	const robots = await OpentronsRobot.find({ isActive: true })
		.select('_id name ip port')
		.sort({ name: 1 })
		.lean();

	return {
		robots: JSON.parse(JSON.stringify(robots)) as Array<{
			_id: string;
			name: string;
			ip: string;
			port?: number;
		}>
	};
};
