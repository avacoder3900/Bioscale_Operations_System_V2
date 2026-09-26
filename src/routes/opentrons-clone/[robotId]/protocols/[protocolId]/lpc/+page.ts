import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import { cloneLine, robotFrom } from '../../../../clone-session';
import { loadProtocol } from '../../../../clone-api';

export const ssr = false;

export const load: PageLoad = async ({ params, parent }) => {
	const { robots } = await parent();
	const robot = robotFrom(robots, params.robotId);
	const line = await cloneLine(params.robotId).ready;
	const p = await loadProtocol(line, params.protocolId);
	if (p.notFound) throw error(404, 'Protocol not found');
	return {
		robot,
		protocolId: params.protocolId,
		online: p.online,
		protocol: p.protocol,
		latestAnalysis: p.latestAnalysis,
		instruments: p.instruments,
		instrumentsReachable: p.instrumentsReachable
	};
};
