import { redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, Equipment, WaxFillingRun, ReagentBatchRecord } from '$lib/server/db';
import type { LayoutServerLoad } from './$types';

// Extend Vercel serverless timeout to 60s
export const config = { maxDuration: 60 };

const ACTIVE_STAGES = ['Setup', 'Loading', 'Running', 'Awaiting Removal', 'QC', 'Storage',
	'setup', 'loading', 'running', 'awaiting_removal', 'cooling', 'qc', 'storage'];

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

		const REAGENT_ACTIVE_STAGES = ['Setup', 'Loading', 'Running', 'Inspection', 'Top Sealing', 'Storage',
			'setup', 'loading', 'running', 'inspection', 'top_sealing', 'storage'];

		const [robots, activeRuns, activeReagentRuns] = await Promise.all([
			Equipment.find({ equipmentType: 'robot', isActive: true }, { _id: 1, name: 1, robotSide: 1 }).sort({ name: 1 }).lean(),
			// Only runs whose OT-2 hasn't finished count as locking a robot here.
			WaxFillingRun.find(
				{ status: { $in: ACTIVE_STAGES }, robotReleasedAt: { $exists: false } },
				{ 'robot._id': 1, status: 1, runStartTime: 1, runEndTime: 1, deckId: 1 }
			).lean(),
			ReagentBatchRecord.find(
				{ status: { $in: REAGENT_ACTIVE_STAGES }, robotReleasedAt: { $exists: false } },
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
