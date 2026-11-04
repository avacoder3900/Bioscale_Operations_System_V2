/**
 * Calibrate landing — the two calibrations are sub-tabs; open on the arm's.
 */
import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	redirect(302, '/manufacturing/cart-mfg/robot-arm/calibrate/arm');
};
