/**
 * Opentron Control hub — DEPRECATED (WAX-FLOW-STREAMLINE). The hub is retired;
 * entry points are the Wax Filling / Reagent Filling tabs. Any visit redirects
 * there. Sub-routes (scanner-positions teaching, per-run QC views) remain.
 */
import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	redirect(302, '/manufacturing/cart-mfg/wax-filling');
};
