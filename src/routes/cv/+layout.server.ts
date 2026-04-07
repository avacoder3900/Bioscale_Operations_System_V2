import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	return {
		user: {
			id: (locals.user as any)._id as string,
			username: (locals.user as any).username as string
		}
	};
};
