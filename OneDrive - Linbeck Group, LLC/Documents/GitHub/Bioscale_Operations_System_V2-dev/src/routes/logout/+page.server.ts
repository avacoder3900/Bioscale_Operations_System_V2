import { redirect } from '@sveltejs/kit';
import { invalidateSession, deleteSessionTokenCookie } from '$lib/server/auth';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	redirect(302, '/');
};

export const actions: Actions = {
	default: async (event) => {
		if (event.locals.session) {
			await invalidateSession(event.locals.session._id);
		}
		deleteSessionTokenCookie(event);
		redirect(302, '/login');
	}
};
