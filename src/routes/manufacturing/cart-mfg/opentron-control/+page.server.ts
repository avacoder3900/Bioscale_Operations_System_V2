/**
 * Opentron Control hub — retired. The Robots page (ROBOT-OVERHAUL, 2026-10-07)
 * is the one place to see and drive every OT-2 for wax and reagent filling.
 * Sub-routes that are still tools (scanner-test, sweeps) remain.
 */
import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	redirect(308, '/manufacturing/cart-mfg/robots');
};
