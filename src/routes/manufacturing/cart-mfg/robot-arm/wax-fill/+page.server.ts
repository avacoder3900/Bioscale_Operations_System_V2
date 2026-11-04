/**
 * Old URL kept for bookmarks and deep links; the page moved in the 2026-11 Robot Arm UI redesign.
 */
import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	redirect(301, '/manufacturing/cart-mfg/robot-arm/run');
};
