import type { PageLoad } from './$types';
import { openRobotSession } from '$lib/opentrons/direct-client';
import { readProtocolLive, sessionRobotClient } from '$lib/opentrons/robot-client';

// OT2-TAILNET-5 S7: protocol + latest analysis from the robot, over the session.
export const ssr = false;

export const load: PageLoad = async ({ data }) => {
	const session = await openRobotSession(data.robotId);
	try {
		const live = await readProtocolLive(sessionRobotClient(session), data.otProtocolId);
		return { ...data, ...live, analysis: live.analysis as typeof data.analysis };
	} finally {
		session.close();
	}
};
