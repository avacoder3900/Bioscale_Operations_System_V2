import { redirect } from '@sveltejs/kit';
import { connectDB, OpentronsRobot } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import { getRobotsHealth, heartbeatFields } from '$lib/server/opentrons/health';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();
	const robots = await OpentronsRobot.find().sort({ name: 1 }).lean();
	const health = await getRobotsHealth(robots.map((r: any) => ({ _id: String(r._id), name: r.name }))).catch(() => ({}) as Record<string, any>);

	return {
		robots: robots.map((r: any) => ({
			robotId: r._id,
			name: r.name ?? '',
			ip: r.ip ?? '',
			port: r.port ?? 31950,
			robotSide: r.robotSide ?? null,
			robotModel: r.robotModel ?? 'OT-2',
			robotSerial: r.robotSerial ?? null,
			isActive: r.isActive ?? true,
			// From the bridge heartbeat, not the dead lastHealthOk/lastHealthAt fields.
			...heartbeatFields(health[String(r._id)]),
			source: r.source ?? 'manual'
		}))
	};
};

export const config = { maxDuration: 60 };
