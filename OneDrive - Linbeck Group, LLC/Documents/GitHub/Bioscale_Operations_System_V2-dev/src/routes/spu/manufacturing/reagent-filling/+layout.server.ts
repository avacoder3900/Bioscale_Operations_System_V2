import { redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, OpentronsRobot, ReagentBatchRecord } from '$lib/server/db';
import type { LayoutServerLoad } from './$types';

const TERMINAL = new Set(['completed', 'aborted', 'voided', 'cancelled', 'Completed', 'Aborted', 'Cancelled']);

export const load: LayoutServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'reagentFilling:read');

	await connectDB();
	const robots = await OpentronsRobot.find({ isActive: true }, { _id: 1, name: 1, robotSide: 1 }).lean();

	// Fetch active reagent runs for all robots
	const activeRuns = await ReagentBatchRecord.find(
		{ status: { $nin: [...TERMINAL] } },
		{ 'robot._id': 1, status: 1, runStartTime: 1, runEndTime: 1, cartridgeCount: 1, 'assayType.name': 1 }
	).lean();

	return {
		user: JSON.parse(JSON.stringify(locals.user)),
		robots: (robots as any[]).map((r) => ({
			robotId: r._id, name: r.name, description: r.robotSide ?? null
		})),
		dashboardState: (robots as any[]).map((r) => {
			const run = (activeRuns as any[]).find((ar) => ar.robot?._id === r._id);
			return {
				robotId: r._id,
				name: r.name,
				description: r.robotSide ?? null,
				hasActiveRun: !!run,
				runId: run ? String(run._id) : null,
				stage: run ? (run.status ?? null) : null,
				assayTypeName: run?.assayType?.name ?? null,
				runStartTime: run?.runStartTime ? new Date(run.runStartTime).toISOString() : null,
				runEndTime: run?.runEndTime ? new Date(run.runEndTime).toISOString() : null,
				cartridgeCount: run?.cartridgeCount ?? 0,
				postRobotRuns: []
			};
		})
	};
};
