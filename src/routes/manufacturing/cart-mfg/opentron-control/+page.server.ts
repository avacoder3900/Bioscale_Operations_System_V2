/**
 * Opentron Control — landing page (kept as backup route; primary entry points
 * are now the Wax Filling / Reagent Filling tabs — see WAX-FLOW-1 PRD).
 * Shows: robots (with availability), wax post-OT-2 queue, reagent post-OT-2 queue.
 */
import { redirect } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db';
import { loadRobotCardsAndQueues } from '$lib/server/manufacturing/robot-cards';
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad } from './$types';

export const config = { maxDuration: 60 };

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();

	const { robotCards, waxQueue, reagentQueue, maxTimeBeforeSealMin } =
		await loadRobotCardsAndQueues();

	return {
		robotCards: JSON.parse(JSON.stringify(robotCards)),
		waxQueue: JSON.parse(JSON.stringify(waxQueue)),
		reagentQueue: JSON.parse(JSON.stringify(reagentQueue)),
		maxTimeBeforeSealMin
	};
};
