import type { PageLoad } from './$types';
import { cloneLine, robotFrom } from '../../clone-session';
import { loadProtocols } from '../../clone-api';

export const ssr = false;

export const load: PageLoad = async ({ params, parent }) => {
	const { robots } = await parent();
	const robot = robotFrom(robots, params.robotId);
	const line = await cloneLine(params.robotId).ready;
	return { robot, ...(await loadProtocols(line)) };
};
