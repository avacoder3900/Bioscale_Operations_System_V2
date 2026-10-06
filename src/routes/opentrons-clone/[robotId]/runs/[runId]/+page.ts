import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import { cloneLine, robotFrom } from '../../../clone-session';
import { loadRun } from '../../../clone-api';

export const ssr = false;

export const load: PageLoad = async ({ params, parent, url }) => {
	const { robots } = await parent();
	const robot = robotFrom(robots, params.robotId);
	const line = await cloneLine(params.robotId).ready;
	const cmdLimit = Math.min(parseInt(url.searchParams.get('cmdLimit') ?? '50', 10) || 50, 200);
	const { notFound, ...rest } = await loadRun(line, params.runId, cmdLimit);
	if (notFound) throw error(404, 'Run not found');
	return { robot, runId: params.runId, ...rest };
};
