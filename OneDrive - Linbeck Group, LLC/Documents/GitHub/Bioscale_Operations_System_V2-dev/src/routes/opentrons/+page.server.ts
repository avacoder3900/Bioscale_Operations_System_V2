import { connectDB, OpentronsRobot } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	await connectDB();
	const robots = await OpentronsRobot.find({ isActive: true }).lean();

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
			lastHealthOk: r.lastHealthOk ?? false
		})),
		protocolRecords
	};
};
