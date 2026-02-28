import { redirect } from '@sveltejs/kit';
import { invalidateSession, deleteSessionTokenCookie } from '$lib/server/auth';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/demo/lucia/login');
	return { user: locals.user };
};

export const actions: Actions = {
	logout: async (event) => {
		if (event.locals.session) {
			await invalidateSession(event.locals.session._id);
		}
		deleteSessionTokenCookie(event);
		redirect(302, '/demo/lucia/login');
	}
};
