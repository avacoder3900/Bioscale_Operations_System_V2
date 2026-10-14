import { redirect } from '@sveltejs/kit';
import { connectDB, OpentronsRobot } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import { getRobotsHealth, heartbeatFields } from '$lib/server/opentrons/health';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();
	const robots = await OpentronsRobot.find({ isActive: true }).lean();
	// Live status from the bridge heartbeat (health.ts) — the robot record's
	// lastHealthOk is a dead field, see heartbeatFields().
	const health = await getRobotsHealth(robots.map((r: any) => ({ _id: String(r._id), name: r.name }))).catch(() => ({}) as Record<string, any>);

	const protocolRecords: any[] = [];
	for (const robot of robots) {
		for (const proto of (robot as any).protocols ?? []) {
			protocolRecords.push({
				id: proto._id,
				robotId: robot._id,
				opentronsProtocolId: proto.opentronsProtocolId ?? null,
				protocolName: proto.protocolName ?? null,
				protocolType: proto.protocolType ?? null,
				analysisStatus: proto.analysisStatus ?? null,
				pipettesRequired: proto.pipettesRequired ?? null,
				labwareDefinitions: proto.labwareDefinitions ?? null,
				parametersSchema: proto.parametersSchema ?? null,
				updatedAt: proto.updatedAt ? new Date(proto.updatedAt).toISOString() : new Date().toISOString()
			});
		}
	}

	return {
		robots: robots.map((r: any) => ({
			robotId: r._id,
			name: r.name ?? '',
			ip: r.ip ?? '',
			...heartbeatFields(health[String(r._id)])
		})),
		protocolRecords
	};
};

export const config = { maxDuration: 60 };
