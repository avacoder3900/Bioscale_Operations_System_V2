import { redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, OpentronsRobot } from '$lib/server/db';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');

	try {
		requirePermission(locals.user, 'waxFilling:read');
	} catch (e: unknown) {
		if (e && typeof e === 'object' && 'status' in e) throw e;
		console.error('[WAX-FILLING LAYOUT] Permission check error:', e instanceof Error ? e.message : e);
	}

	await connectDB();
	const robots = await OpentronsRobot.find({ isActive: true }, { _id: 1, name: 1, robotSide: 1 }).lean();

	return {
		user: locals.user,
		robots: robots.map((r) => ({
			robotId: r._id, name: r.name, description: r.robotSide ?? null
		})),
		dashboardState: robots.map((r) => ({
			robotId: r._id, name: r.name, description: r.robotSide ?? null,
			hasActiveRun: false, runId: null, stage: null,
			runStartTime: null, runEndTime: null, deckId: null, alerts: []
		}))
	};
};
