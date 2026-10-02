import { error, redirect } from '@sveltejs/kit';
import { connectDB, OpentronsRobot } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad } from './$types';

/** Shown when the robot doesn't answer (same stub as before). */
function stubRun(runId: string) {
	return {
		id: runId,
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
	} as any;
}

export const load: PageServerLoad = async ({ params, url, locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();
	const robotId = url.searchParams.get('robotId');
	if (!robotId) error(400, 'robotId query parameter is required');

	const robot = await OpentronsRobot.findById(robotId).lean() as any;
	if (!robot) error(404, 'Robot not found');

	return {
		robotId,
		robotName: robot.name ?? '',
		// OT2-TAILNET-5 S7: the run itself is read in the browser (+page.ts).
		run: stubRun(params.runId)
	};
};

