import type { PageLoad } from './$types';
import { openRobotSession } from '$lib/opentrons/direct-client';
import { readDeviceLive, sessionRobotClient } from '$lib/opentrons/robot-client';

// OT2-TAILNET-5 S7: health / pipettes / recent runs come from the robot via this
// browser's robot session (direct over Tailscale, or the BIMS relay/queue).
export const ssr = false;

export const load: PageLoad = async ({ data }) => {
	const session = await openRobotSession(data.robot.robotId);
	try {
		const live = await readDeviceLive(sessionRobotClient(session), data.robot.name);
		return { ...data, ...live, transport: session.state.transport };
	} finally {
		session.close();
	}
};
