import { redirect } from '@sveltejs/kit';
import { connectDB, OpentronsRobot } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url, locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:write');
	await connectDB();
	const preselectedRobotId = url.searchParams.get('robotId');
	const preselectedProtocolId = url.searchParams.get('protocolId');

	const robots = await OpentronsRobot.find({ isActive: true }).lean();

	return {
		preselectedRobotId,
		preselectedProtocolId,
		robots: robots.map((r: any) => ({
			robotId: r._id,
			name: r.name ?? '',
			ip: r.ip ?? '',
			lastHealthOk: r.lastHealthOk ?? false
		})),
		// OT2-TAILNET-5 S7: the preselected protocol + analysis are read in the
		// browser (+page.ts) over the robot session.
		protocol: null as any,
		analysis: null as any
	};
};

