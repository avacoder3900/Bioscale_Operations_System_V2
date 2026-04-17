import { error, fail, redirect } from '@sveltejs/kit';
import { connectDB, OpentronsRobot } from '$lib/server/db';
import { createRobotClient, robotBaseUrl } from '$lib/server/opentrons/client';
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad, Actions } from './$types';

interface RobotDoc {
	_id: string;
	name: string;
	ip: string;
	port?: number;
}

async function getRobot(robotId: string): Promise<RobotDoc> {
	await connectDB();
	const robot = (await OpentronsRobot.findById(robotId)
		.select('_id name ip port')
		.lean()) as RobotDoc | null;
	if (!robot) throw error(404, 'Robot not found');
	return robot;
}

export const load: PageServerLoad = async ({ params }) => {
	const robot = await getRobot(params.robotId);
	const client = createRobotClient({ ip: robot.ip, port: robot.port }, { timeoutMs: 5000 });

	let protocol: any = null;
	let analyses: any[] = [];
	let latestAnalysis: any = null;
	let online = true;

	try {
		const detailRes = await (client as any).GET('/protocols/{protocolId}', {
			params: { path: { protocolId: params.protocolId } }
		});
		if (detailRes.error !== undefined) {
			if (detailRes.response.status === 404) throw error(404, 'Protocol not found');
			online = false;
		} else {
			protocol = detailRes.data?.data ?? null;
		}

		const analysesRes = await (client as any).GET('/protocols/{protocolId}/analyses', {
			params: { path: { protocolId: params.protocolId } }
		});
		if (analysesRes.error === undefined) {
			analyses = analysesRes.data?.data ?? [];
			if (analyses.length > 0) {
				const latest = analyses[analyses.length - 1];
				if (latest?.id) {
					const detailAnalysisRes = await (client as any).GET(
						'/protocols/{protocolId}/analyses/{analysisId}',
						{ params: { path: { protocolId: params.protocolId, analysisId: latest.id } } }
					);
					if (detailAnalysisRes.error === undefined) {
						latestAnalysis = detailAnalysisRes.data?.data ?? null;
					}
				}
			}
		}
	} catch (e: any) {
		if (e?.status) throw e;
		online = false;
	}

	return {
		robot: JSON.parse(JSON.stringify(robot)),
		protocolId: params.protocolId,
		online,
		protocol: JSON.parse(JSON.stringify(protocol)),
		analyses: JSON.parse(JSON.stringify(analyses)),
		latestAnalysis: JSON.parse(JSON.stringify(latestAnalysis))
	};
};

export const actions: Actions = {
	delete: async ({ params, locals }) => {
		requirePermission(locals.user, 'manufacturing:write');
		const robot = await getRobot(params.robotId);

		try {
			const res = await fetch(
				`${robotBaseUrl(robot)}/protocols/${encodeURIComponent(params.protocolId as string)}`,
				{
					method: 'DELETE',
					headers: { 'opentrons-version': '*' },
					signal: AbortSignal.timeout(10_000)
				}
			);
			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				return fail(res.status, { error: 'Delete failed', details: err });
			}
		} catch (e) {
			return fail(502, { error: `Robot unreachable: ${(e as Error).message}` });
		}

		throw redirect(303, `/opentrons-clone/${params.robotId}/protocols`);
	}
};
