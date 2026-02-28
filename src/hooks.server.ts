import type { Handle } from '@sveltejs/kit';
import { redirect } from '@sveltejs/kit';
import * as auth from '$lib/server/auth';

const PUBLIC_PATHS = ['/login', '/invite/accept', '/demo/lucia/login'];

const handleAuth: Handle = async ({ event, resolve }) => {
	const sessionToken = event.cookies.get(auth.sessionCookieName);

	if (!sessionToken) {
		event.locals.user = null;
		event.locals.session = null;
	} else {
		const { session, user } = await auth.validateSessionToken(sessionToken);

		if (session) {
			auth.setSessionTokenCookie(event, sessionToken, session.expiresAt);
		} else {
			auth.deleteSessionTokenCookie(event);
		}

		event.locals.user = user;
		event.locals.session = session;
	}

	// Protect routes
	const path = event.url.pathname;
	const isPublic = PUBLIC_PATHS.some((p) => path.startsWith(p)) || path === '/';
	const isApi = path.startsWith('/api/');

	if (!isPublic && !isApi && !event.locals.user) {
		throw redirect(302, '/login');
	}

	return resolve(event);
};

export const handle: Handle = handleAuth;
