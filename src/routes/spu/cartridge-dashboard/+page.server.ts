import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// The cartridge dashboard now lives at /spu (the main dashboard).
export const load: PageServerLoad = async () => {
	redirect(308, '/spu');
};
