import { redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, Equipment, WaxFillingRun, ReagentBatchRecord } from '$lib/server/db';
import type { LayoutServerLoad } from './$types';

// Extend Vercel serverless timeout to 60s
export const config = { maxDuration: 60 };

// Stages where the operator is still actively handling this run on the
// wax-filling page (PostRunCooling runs during 'Awaiting Removal'). Once
// status moves to QC / Storage, the run lives on the Opentron Control
// post-OT-2 queue and the robot becomes Available for a new run.
const WAX_PAGE_OWNED = ['Setup', 'Loading', 'Running', 'Awaiting Removal',
	'setup', 'loading', 'running', 'awaiting_removal', 'cooling'];

export const load: LayoutServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');

	try {
		requirePermission(locals.user, 'waxFilling:read');
	} catch (e: unknown) {
		if (e && typeof e === 'object' && 'status' in e) throw e;
		console.error('[WAX-FILLING LAYOUT] Permission check error:', e instanceof Error ? e.message : e);
	}

	try {
		await connectDB();

		// Mirror of reagent-filling's layout: reagent runs lock the robot from
		// wax until they pass Inspection (i.e. only Top Sealing / Storage free
		// the robot).
		const REAGENT_PAGE_OWNED = ['Setup', 'Loading', 'Running', 'Inspection',
			'setup', 'loading', 'running', 'inspection'];

		const [robots, activeRuns, activeReagentRuns] = await Promise.all([
			Equipment.find({ equipmentType: 'robot', isActive: true }, { _id: 1, name: 1, robotSide: 1 }).sort({ name: 1 }).lean(),
			WaxFillingRun.find(
				{ status: { $in: WAX_PAGE_OWNED } },
				{ 'robot._id': 1, status: 1, runStartTime: 1, runEndTime: 1, deckId: 1 }
			).lean(),
			ReagentBatchRecord.find(
				{ status: { $in: REAGENT_PAGE_OWNED } },
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
				const waxRun = (activeRuns as any[]).find(
					(ar) => String(ar.robot?._id) === robotIdStr
				);
				const reagentRun = (activeReagentRuns as any[]).find(
					(ar: any) => String(ar.robot?._id) === robotIdStr
				);
				const hasWax = !!waxRun;
				const hasReagent = !!reagentRun;
				return {
					robotId: robotIdStr,
					name: r.name ?? '',
					description: r.robotSide ?? null,
					hasActiveRun: hasWax || hasReagent,
					activeProcess: hasWax ? 'wax' : hasReagent ? 'reagent' : null,
					runId: waxRun ? String(waxRun._id) : reagentRun ? String(reagentRun._id) : null,
					stage: waxRun ? (waxRun.status ?? null) : reagentRun ? (reagentRun.status ?? null) : null,
					runStartTime: waxRun?.runStartTime ? new Date(waxRun.runStartTime).toISOString() : null,
					runEndTime: waxRun?.runEndTime ? new Date(waxRun.runEndTime).toISOString() : null,
					deckId: waxRun?.deckId ?? null,
					alerts: []
				};
			})
		};
	} catch (err) {
		console.error('[WAX-FILLING LAYOUT] DB error:', err instanceof Error ? err.message : err);
		// Return safe defaults so the page can still render with an error state
		return {
			user: JSON.parse(JSON.stringify(locals.user)),
			robots: [],
			dashboardState: []
		};
	}
};
