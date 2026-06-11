/**
 * Robot Arm landing route — redirected to /control.
 *
 * The control page (sibling /control/+page.svelte) is now the canonical
 * Robot Arm UI. The previous landing /manufacturing/robot-arm/+page.svelte
 * was deleted (it duplicated control's actions + added stale arms/runs
 * dashboards). Any GET here 302s straight to /control before render.
 *
 * Restore by `git restore --source <prev-commit> -- src/routes/manufacturing/robot-arm/+page.svelte`
 * and replacing this file with the prior load + actions.
 */
import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	redirect(302, '/manufacturing/robot-arm/control');
};
