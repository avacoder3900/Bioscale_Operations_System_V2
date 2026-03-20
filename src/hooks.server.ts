import type { Handle } from '@sveltejs/kit';
import { redirect } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import * as auth from '$lib/server/auth';
import { uploadFile } from '$lib/server/box';
import { env } from '$env/dynamic/private';

const PUBLIC_PATHS = ['/login', '/invite/accept'];

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

/**
 * Intercept raw fetch calls to the uploadCoc form action.
 * SvelteKit form actions return HTML for requests without the x-sveltekit-action
 * header, but the client-side code does a raw fetch expecting JSON.
 * This handler catches those requests and returns plain JSON directly.
 */
const handleFormActionJson: Handle = async ({ event, resolve }) => {
	if (
		event.request.method === 'POST' &&
		event.url.pathname === '/spu/receiving/new' &&
		event.url.searchParams.has('/uploadCoc') &&
		!event.request.headers.get('x-sveltekit-action')
	) {
		if (!event.locals.user) {
			return new Response(JSON.stringify({ error: 'Unauthorized' }), {
				status: 401,
				headers: { 'Content-Type': 'application/json' }
			});
		}

		const formData = await event.request.formData();
		const file = formData.get('cocFile') as File | null;
		const partId = formData.get('partId')?.toString();

		if (!file || !partId) {
			return new Response(JSON.stringify({ error: 'File and part are required' }), {
				status: 400,
				headers: { 'Content-Type': 'application/json' }
			});
		}

		try {
			const buffer = await file.arrayBuffer();
			const ext = file.name.split('.').pop() ?? 'bin';
			const fileName = `coc-${partId}-${Date.now()}.${ext}`;
			const folderId = env.BOX_ROOT_FOLDER_ID ?? '0';

			const uploaded = await uploadFile(folderId, fileName, buffer);
			const cocUrl = `https://app.box.com/files/${uploaded.id}`;

			return new Response(JSON.stringify({ data: [{ success: true, cocUrl }] }), {
				headers: { 'Content-Type': 'application/json' }
			});
		} catch (err) {
			return new Response(
				JSON.stringify({ error: err instanceof Error ? err.message : 'Upload failed' }),
				{ status: 500, headers: { 'Content-Type': 'application/json' } }
			);
		}
	}

	return resolve(event);
};

export const handle: Handle = sequence(handleAuth, handleFormActionJson);
