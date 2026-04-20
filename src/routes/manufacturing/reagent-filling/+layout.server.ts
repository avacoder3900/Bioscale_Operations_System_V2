import { redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, Equipment, ReagentBatchRecord, WaxFillingRun } from '$lib/server/db';
import type { LayoutServerLoad } from './$types';

// Extend Vercel serverless timeout to 60s
export const config = { maxDuration: 60 };

const TERMINAL = new Set(['completed', 'aborted', 'voided', 'cancelled', 'Completed', 'Aborted', 'Cancelled']);

export const load: LayoutServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');

	try {
		requirePermission(locals.user, 'reagentFilling:read');
	} catch (e: unknown) {
		if (e && typeof e === 'object' && 'status' in e) throw e;
		console.error('[REAGENT-FILLING LAYOUT] Permission check error:', e instanceof Error ? e.message : e);
	}

	try {
		await connectDB();

		// Stages where the operator is still actively handling this run on the
		// filling page. A robot is "locked" during these — tabs show the stage
		// badge, new runs are blocked, and Opentron Control shows "In Use".
		// Once status moves past these (Top Sealing / Storage for reagent;
		// QC / Storage for wax), the run goes to the post-OT-2 queue on
		// Opentron Control and the robot becomes Available.
		const REAGENT_PAGE_OWNED = ['Setup', 'Loading', 'Running', 'Inspection',
			'setup', 'loading', 'running', 'inspection'];
		const WAX_PAGE_OWNED = ['Setup', 'Loading', 'Running', 'Awaiting Removal',
			'setup', 'loading', 'running', 'awaiting_removal', 'cooling'];

		const [robots, activeRuns, activeWaxRuns] = await Promise.all([
			Equipment.find({ equipmentType: 'robot', isActive: true }, { _id: 1, name: 1, robotSide: 1 }).sort({ name: 1 }).lean(),
			ReagentBatchRecord.find(
				{ status: { $in: REAGENT_PAGE_OWNED } },
				{ 'robot._id': 1, status: 1, runStartTime: 1, runEndTime: 1, cartridgeCount: 1, 'assayType.name': 1 }
			).lean(),
			WaxFillingRun.find(
				{ status: { $in: WAX_PAGE_OWNED } },
				{ 'robot._id': 1, status: 1 }
			).lean().catch(() => [])
		]);

		return {
			user: JSON.parse(JSON.stringify(locals.user)),
			robots: (robots as any[]).map((r) => ({
				// Stringify ObjectId to ensure proper serialization on Vercel
				robotId: String(r._id),
				name: r.name ?? '',
				description: r.robotSide ?? null
			})),
			dashboardState: (robots as any[]).map((r) => {
				const robotIdStr = String(r._id);
				const reagentRun = (activeRuns as any[]).find(
					(ar) => String(ar.robot?._id) === robotIdStr
				);
				const waxRun = (activeWaxRuns as any[]).find(
					(ar: any) => String(ar.robot?._id) === robotIdStr
				);
				const hasReagent = !!reagentRun;
				const hasWax = !!waxRun;
				return {
					robotId: robotIdStr,
					name: r.name ?? '',
					description: r.robotSide ?? null,
					hasActiveRun: hasReagent || hasWax,
					activeProcess: hasReagent ? 'reagent' : hasWax ? 'wax' : null,
					runId: reagentRun ? String(reagentRun._id) : waxRun ? String(waxRun._id) : null,
					stage: reagentRun ? (reagentRun.status ?? null) : waxRun ? (waxRun.status ?? null) : null,
					assayTypeName: reagentRun?.assayType?.name ?? null,
					runStartTime: reagentRun?.runStartTime ? new Date(reagentRun.runStartTime).toISOString() : null,
					runEndTime: reagentRun?.runEndTime ? new Date(reagentRun.runEndTime).toISOString() : null,
					cartridgeCount: reagentRun?.cartridgeCount ?? 0,
					postRobotRuns: []
				};
			})
		};
	} catch (err) {
		console.error('[REAGENT-FILLING LAYOUT] DB error:', err instanceof Error ? err.message : err);
		// Return safe defaults so the page can still render with an error state
		return {
			user: JSON.parse(JSON.stringify(locals.user)),
			robots: [],
			dashboardState: []
		};
	}
};
