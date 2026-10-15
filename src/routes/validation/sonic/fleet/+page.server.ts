import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/** Fleet comparison merged into /validation/sonic/compare as its "Fleet check" view (2026-10-06). */
export const load: PageServerLoad = async () => {
	throw redirect(308, '/validation/sonic/compare?view=fleet');
};
