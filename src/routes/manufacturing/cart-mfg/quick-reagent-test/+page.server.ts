/**
 * Quick Reagent Fill Test was replaced by the generic State Change page
 * (target status + optional 'Clear reagent fill'). Kept as a permanent
 * redirect so old links/bookmarks still land somewhere useful.
 */
import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	redirect(308, '/manufacturing/cart-mfg/state-change');
};
