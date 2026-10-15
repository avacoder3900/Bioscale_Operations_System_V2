import type { PageLoad } from './$types';
import { openRobotSession } from '$lib/opentrons/direct-client';
import { readProtocolLive, sessionRobotClient } from '$lib/opentrons/robot-client';

// OT2-TAILNET-5 S7: the preselected protocol + analysis come from the robot over
// the session (only when both a robot and a protocol are preselected, as before).
export const ssr = false;

export const load: PageLoad = async ({ data }) => {
	const { preselectedRobotId, preselectedProtocolId } = data;
	if (!preselectedRobotId || !preselectedProtocolId) return data;
	if (!data.robots.some((r: { robotId: string }) => r.robotId === preselectedRobotId)) return data;
	const session = await openRobotSession(preselectedRobotId);
	try {
		const live = await readProtocolLive(sessionRobotClient(session), preselectedProtocolId);
		return { ...data, protocol: live.protocol, analysis: live.analysis };
	} finally {
		session.close();
	}
};
