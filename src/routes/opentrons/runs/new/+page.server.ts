import { redirect } from '@sveltejs/kit';
import { connectDB, OpentronsRobot } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import { getRobotsHealth, heartbeatFields } from '$lib/server/opentrons/health';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url, locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:write');
	await connectDB();
	const preselectedRobotId = url.searchParams.get('robotId');
	const preselectedProtocolId = url.searchParams.get('protocolId');

	const robots = await OpentronsRobot.find({ isActive: true }).lean();
	const health = await getRobotsHealth(robots.map((r: any) => ({ _id: String(r._id), name: r.name }))).catch(() => ({}) as Record<string, any>);

	return {
		preselectedRobotId,
		preselectedProtocolId,
		robots: robots.map((r: any) => ({
			robotId: r._id,
			name: r.name ?? '',
			ip: r.ip ?? '',
			...heartbeatFields(health[String(r._id)])
		})),
		// OT2-TAILNET-5 S7: the preselected protocol + analysis are read in the
		// browser (+page.ts) over the robot session.
		protocol: null as any,
		analysis: null as any
	};
};

