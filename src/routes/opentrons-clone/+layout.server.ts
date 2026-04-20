import { redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import type { LayoutServerLoad } from './$types';

const COOKIE_NAME = 'ot_operator_auth';
const COOKIE_VALUE = 'ok';

export const load: LayoutServerLoad = async ({ locals, url, cookies }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');

	// Operator-admin gate — extra password wall for the clone.
	const isLoginPage = url.pathname === '/opentrons-clone/operator-login';
	const authed = cookies.get(COOKIE_NAME) === COOKIE_VALUE;
	if (!authed && !isLoginPage) {
		const next = encodeURIComponent(url.pathname + url.search);
		throw redirect(303, `/opentrons-clone/operator-login?next=${next}`);
	}

	return {
		user: { id: locals.user._id, username: locals.user.username },
		operatorAuthed: authed
	};
};

export const config = { maxDuration: 60 };
