/**
 * /manufacturing/cart-mfg/opentrons[/history] moved to /robots[/history]
 * (ROBOT-OVERHAUL, 2026-10-07). Permanent redirect so bookmarks keep working.
 */
import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, url }) => {
	const rest = params.path ? `/${params.path}` : '';
	redirect(308, `/manufacturing/cart-mfg/robots${rest}${url.search}`);
};
