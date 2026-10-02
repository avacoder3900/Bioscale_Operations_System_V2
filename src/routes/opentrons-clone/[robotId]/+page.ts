import type { PageLoad } from './$types';
import { cloneLine, robotFrom } from '../clone-session';
import { loadOverview } from '../clone-api';

// OT2-TAILNET-5 S10b: the robot is read from the browser, over the robot session.
export const ssr = false;

export const load: PageLoad = async ({ params, parent }) => {
	const { robots } = await parent();
	const robot = robotFrom(robots, params.robotId);
	const line = await cloneLine(params.robotId).ready;
	return { robot, ...(await loadOverview(line)) };
};
