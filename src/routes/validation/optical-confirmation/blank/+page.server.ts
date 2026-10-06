import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/** Blank Cartridge moved to /validation/blank (2026-10-06) when optical confirmation was banked. */
export const load: PageServerLoad = async () => {
	throw redirect(308, '/validation/blank');
};
