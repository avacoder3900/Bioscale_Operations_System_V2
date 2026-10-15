import type { PageLoad } from './$types';
import { cloneLine, robotFrom } from '../../clone-session';
import { loadRuns } from '../../clone-api';

export const ssr = false;

export const load: PageLoad = async ({ params, parent, url }) => {
	const { robots } = await parent();
	const robot = robotFrom(robots, params.robotId);
	const line = await cloneLine(params.robotId).ready;
	const limit = parseInt(url.searchParams.get('limit') ?? '25', 10) || 25;
	return { robot, ...(await loadRuns(line, limit)) };
};
