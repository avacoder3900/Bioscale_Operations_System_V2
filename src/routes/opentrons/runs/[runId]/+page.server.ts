import { error, redirect } from '@sveltejs/kit';
import { connectDB, OpentronsRobot } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, url, locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();
	const robotId = url.searchParams.get('robotId');
	if (!robotId) error(400, 'robotId query parameter is required');

	const robot = await OpentronsRobot.findById(robotId).lean() as any;
	if (!robot) error(404, 'Robot not found');

	let run: any = null;
	try {
		const resp = await fetch(
			`http://${robot.ip}:${robot.port ?? 31950}/runs/${params.runId}`,
			{ signal: AbortSignal.timeout(5000) }
		);
		if (resp.ok) {
			const data = await resp.json();
			run = data.data ?? data;
		}
	} catch { /* robot offline */ }

	if (!run) {
		// Return a stub if robot is offline
		run = {
			id: params.runId,
			status: 'unknown',
			current: false,
			protocolId: null,
			createdAt: null,
			startedAt: null,
			completedAt: null,
			errors: [],
			pipettes: [],
			labware: [],
			modules: [],
			liquids: [],
			runTimeParameters: [],
			actions: []
		};
	}

	return {
		robotId,
		robotName: robot.name ?? '',
		run
	};
};

export const config = { maxDuration: 60 };
