import { redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, Equipment, ReagentBatchRecord } from '$lib/server/db';
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

		const [robots, activeRuns] = await Promise.all([
			Equipment.find({ equipmentType: 'robot', isActive: true }, { _id: 1, name: 1, robotSide: 1 }).sort({ name: 1 }).lean(),
			ReagentBatchRecord.find(
				{ status: { $nin: [...TERMINAL] } },
				{ 'robot._id': 1, status: 1, runStartTime: 1, runEndTime: 1, cartridgeCount: 1, 'assayType.name': 1 }
			).lean()
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
				const run = (activeRuns as any[]).find(
					(ar) => String(ar.robot?._id) === robotIdStr
				);
				return {
					robotId: robotIdStr,
					name: r.name ?? '',
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
