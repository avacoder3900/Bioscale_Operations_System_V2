/**
 * Robots page group (ROBOT-OVERHAUL, 2026-10-07) — /manufacturing/cart-mfg/robots
 * and the wax-filling / reagent-filling wizards share this one layout: the
 * robot board (every OT-2, both processes, health) sits above whichever wizard
 * is open, so the operator never leaves the page to work another robot.
 */
import { redirect, error } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db';
import { hasAnyPermission } from '$lib/server/permissions';
import { loadRobotBoard } from '$lib/server/manufacturing/robot-board';
import type { LayoutServerLoad } from './$types';

export const config = { maxDuration: 60 };

export const load: LayoutServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	// The board is readable by anyone who may read either filling process (the
	// two wizards keep their own waxFilling:read / reagentFilling:read gates).
	if (!hasAnyPermission(locals.user, ['manufacturing:read', 'waxFilling:read', 'reagentFilling:read'])) {
		error(403, 'Forbidden');
	}

	try {
		await connectDB();
		return await loadRobotBoard();
	} catch (err) {
		console.error('[ROBOTS LAYOUT] DB error:', err instanceof Error ? err.message : err);
		// Safe defaults so the wizards can still render their own error state.
		return { robots: [], board: [] };
	}
};
