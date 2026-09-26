import { redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { OPERATOR_COOKIE, OPERATOR_COOKIE_PATH } from '$lib/server/opentrons/operator-cookie';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ cookies, locals }) => {
	if (!locals.user) throw redirect(303, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	cookies.delete(OPERATOR_COOKIE, { path: OPERATOR_COOKIE_PATH });
	throw redirect(303, '/opentrons-clone/operator-login');
};
