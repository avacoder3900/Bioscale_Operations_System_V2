import { connectDB, OpentronsRobot } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url }) => {
	await connectDB();
	const preselectedRobotId = url.searchParams.get('robotId');
	const preselectedProtocolId = url.searchParams.get('protocolId');

	const robots = await OpentronsRobot.find({ isActive: true }).lean();

	let protocol: any = null;
	let analysis: any = null;

	if (preselectedRobotId && preselectedProtocolId) {
		const robot = robots.find((r: any) => r._id === preselectedRobotId) as any;
		if (robot) {
			try {
				const resp = await fetch(
					`http://${robot.ip}:${robot.port ?? 31950}/protocols/${preselectedProtocolId}`,
					{ signal: AbortSignal.timeout(3000) }
				);
				if (resp.ok) {
					const data = await resp.json();
					protocol = data.data ?? data;

					const analyses = protocol.analysisSummaries ?? [];
					if (analyses.length > 0) {
						const latestId = analyses[analyses.length - 1].id;
						try {
							const aResp = await fetch(
								`http://${robot.ip}:${robot.port ?? 31950}/protocols/${preselectedProtocolId}/analyses/${latestId}`,
								{ signal: AbortSignal.timeout(3000) }
							);
							if (aResp.ok) {
								analysis = (await aResp.json()).data ?? null;
							}
						} catch { /* ignore */ }
					}
				}
			} catch { /* robot offline */ }
		}
	}

	return {
		preselectedRobotId,
		preselectedProtocolId,
		robots: robots.map((r: any) => ({
			robotId: r._id,
			name: r.name ?? '',
			ip: r.ip ?? '',
			lastHealthOk: r.lastHealthOk ?? false
		})),
		protocol,
		analysis
	};
};
