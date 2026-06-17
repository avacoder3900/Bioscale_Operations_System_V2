import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

const PASSWORD = 'opadmin';
const COOKIE_NAME = 'ot_operator_auth';
const COOKIE_VALUE = 'ok';
const TTL_SECONDS = 8 * 60 * 60;

export const load: PageServerLoad = async ({ cookies, url }) => {
	if (cookies.get(COOKIE_NAME) === COOKIE_VALUE) {
		const next = url.searchParams.get('next') || '/opentrons-clone';
		throw redirect(303, next);
	}
	return { next: url.searchParams.get('next') || '/opentrons-clone' };
};

export const actions: Actions = {
	default: async ({ request, cookies, url }) => {
		const form = await request.formData();
		const password = form.get('password')?.toString() ?? '';
		const next = form.get('next')?.toString() || url.searchParams.get('next') || '/opentrons-clone';
		if (password !== PASSWORD) {
			return fail(401, { error: 'Wrong password' });
		}
		cookies.set(COOKIE_NAME, COOKIE_VALUE, {
			path: '/opentrons-clone',
			httpOnly: true,
			sameSite: 'lax',
			maxAge: TTL_SECONDS
		});
		throw redirect(303, next);
	}
};
