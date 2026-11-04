/**
 * Old URL kept for bookmarks and deep links; the conveyor controls live on the Teach tab.
 */
import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	redirect(301, '/manufacturing/cart-mfg/robot-arm/teach');
};
