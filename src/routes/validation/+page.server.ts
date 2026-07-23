import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	redirect(303, '/validation/runs');
};

export const config = { maxDuration: 60 };
