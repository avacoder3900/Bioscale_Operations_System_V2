/**
 * Initiates Box OAuth 2.0 flow by redirecting to Box authorization page.
 */
import { redirect, json } from '@sveltejs/kit';
import { getAuthUrl } from '$lib/server/box';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
	if (!event.locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	const authUrl = getAuthUrl();
	throw redirect(303, authUrl);
};
