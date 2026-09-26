import type { PageLoad } from './$types';
import { openRobotSession } from '$lib/opentrons/direct-client';
import { readRunLive, sessionRobotClient } from '$lib/opentrons/robot-client';

// OT2-TAILNET-5 S7: the run is read from the robot over the session; the stub
// from the server load stays when the robot doesn't answer.
export const ssr = false;

export const load: PageLoad = async ({ data, params }) => {
	const session = await openRobotSession(data.robotId);
	try {
		const run = await readRunLive(sessionRobotClient(session), params.runId);
		return { ...data, run: run ?? data.run };
	} finally {
		session.close();
	}
};
