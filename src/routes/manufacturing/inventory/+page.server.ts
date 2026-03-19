import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	redirect(302, '/manufacturing/consumables');
};

export const config = { maxDuration: 60 };
