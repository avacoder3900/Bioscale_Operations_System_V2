/**
 * Robot Arm landing route — redirected to /control.
 *
 * The control page (sibling /control/+page.svelte) is now the canonical
 * Robot Arm UI. The previous landing at this path
 * (src/routes/manufacturing/cart-mfg/robot-arm/+page.svelte) was deleted —
 * it duplicated control's actions and added stale arms/runs dashboards.
 * Any GET here 302s straight to /control before render.
 *
 * This route is kept only so old bookmarks/deep links to the bare
 * /robot-arm path still land somewhere. Nav links point at /control
 * directly and should not be pointed back here.
 *
 * To recover the old landing page, find its deleting commit with:
 *   git log --diff-filter=D -- src/routes/manufacturing/cart-mfg/robot-arm/+page.svelte
 */
import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	redirect(302, '/manufacturing/cart-mfg/robot-arm/control');
};
