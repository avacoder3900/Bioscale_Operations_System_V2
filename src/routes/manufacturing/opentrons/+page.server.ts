import { connectDB, OpentronsRobot, WaxFillingRun, ReagentBatchRecord } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad } from './$types';

// Extend Vercel serverless timeout to 60s
export const config = { maxDuration: 60 };

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();

	// Fetch all active robots
	const robots = await OpentronsRobot.find({ isActive: true }, {
		_id: 1, name: 1, robotSide: 1
	}).lean();

	const robotList = robots.map((r: any) => ({
		robotId: r._id,
		name: r.name ?? '',
		description: r.robotSide ?? ''
	}));

	// Fetch active wax filling runs (not completed/aborted)
	const activeWaxRuns = await WaxFillingRun.find({
		status: { $nin: ['completed', 'aborted', 'cancelled'] }
	}).lean();

	// Build wax state per robot
	const waxState = robotList.map((robot) => {
		const run = activeWaxRuns.find((r: any) => r.robot?._id === robot.robotId);
		return {
			robotId: robot.robotId,
			name: robot.name,
			hasActiveRun: !!run,
			stage: run ? (run as any).status ?? null : null,
			alerts: [] as { type: string; message: string }[]
		};
	});

	// Build reagent state per robot using ReagentBatchRecord model
	const activeReagentRuns = await ReagentBatchRecord.find({
		status: { $nin: ['completed', 'aborted', 'cancelled', 'Completed', 'Aborted', 'Cancelled'] }
	}).lean().catch(() => []);

	const reagentState = robotList.map((robot) => {
		const run = (activeReagentRuns as any[]).find((r: any) => r.robot?._id === robot.robotId);
		return {
			robotId: robot.robotId,
			name: robot.name,
			hasActiveRun: !!run,
			stage: run ? run.status ?? null : null,
			assayTypeName: run ? run.assayTypeName ?? null : null
		};
	});

	// Robot availability: a robot is unavailable if it has an active wax OR reagent run
	const robotAvailability = robotList.map((robot) => {
		const wax = waxState.find((w) => w.robotId === robot.robotId);
		const reagent = reagentState.find((r) => r.robotId === robot.robotId);
		const waxActive = wax?.hasActiveRun ?? false;
		const reagentActive = reagent?.hasActiveRun ?? false;
		const activeWax = activeWaxRuns.find((r: any) => r.robot?._id === robot.robotId);
		const activeReagent = (activeReagentRuns as any[]).find((r: any) => r.robot?._id === robot.robotId);

		return {
			robotId: robot.robotId,
			available: !waxActive && !reagentActive,
			activeProcess: waxActive ? 'wax' : reagentActive ? 'reagent' : null,
			activeRunId: activeWax?._id ?? activeReagent?._id ?? null
		};
	});

	// Robot stats: count completed/aborted wax and reagent runs per robot
	const allWaxRuns = await WaxFillingRun.find({}, { 'robot._id': 1, status: 1 }).lean();
	const allReagentRuns = await ReagentBatchRecord.find({}, { 'robot._id': 1, status: 1 }).lean().catch(() => []);

	const robotStats = robotList.map((robot) => {
		const waxRuns = allWaxRuns.filter((r: any) => r.robot?._id === robot.robotId);
		const reagentRuns = (allReagentRuns as any[]).filter((r: any) => r.robot?._id === robot.robotId);

		return {
			robotId: robot.robotId,
			waxRuns: {
				total: waxRuns.length,
				completed: waxRuns.filter((r: any) => r.status === 'completed').length,
				aborted: waxRuns.filter((r: any) => r.status === 'aborted').length
			},
			reagentRuns: {
				total: reagentRuns.length,
				completed: reagentRuns.filter((r: any) => r.status === 'completed').length,
				aborted: reagentRuns.filter((r: any) => r.status === 'aborted').length
			}
		};
	});

	return {
		robots: robotList,
		waxState,
		reagentState,
		robotAvailability,
		robotStats
	};
};
