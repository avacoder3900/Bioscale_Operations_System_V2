import { fail, redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { requirePermission } from '$lib/server/permissions';
import {
	OPERATOR_COOKIE,
	OPERATOR_COOKIE_PATH,
	OPERATOR_TTL_SECONDS,
	operatorCookieSecret,
	signOperatorCookie,
	verifyOperatorCookie
} from '$lib/server/opentrons/operator-cookie';
import type { Actions, PageServerLoad } from './$types';

/** Only same-app relative targets — never an open redirect. */
function safeNext(raw: string | null | undefined): string {
	const n = raw || '/opentrons-clone';
	return n.startsWith('/opentrons-clone') && !n.startsWith('//') ? n : '/opentrons-clone';
}

export const load: PageServerLoad = async ({ cookies, url, locals }) => {
	if (!locals.user) throw redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	const next = safeNext(url.searchParams.get('next'));
	if (verifyOperatorCookie(cookies.get(OPERATOR_COOKIE), operatorCookieSecret({ OT_OPERATOR_COOKIE_SECRET: env.OT_OPERATOR_COOKIE_SECRET, OT_OPERATOR_PASSWORD: env.OT_OPERATOR_PASSWORD }), { userId: String(locals.user._id) })) {
		throw redirect(303, next);
	}
	return { next };
};

export const actions: Actions = {
	default: async ({ request, cookies, url, locals }) => {
		if (!locals.user) throw redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:read');
		const form = await request.formData();
		const password = form.get('password')?.toString() ?? '';
		const next = safeNext(form.get('next')?.toString() || url.searchParams.get('next'));
		// Password lives in env (OT_OPERATOR_PASSWORD), never in the repo. Unset = disabled.
		if (!env.OT_OPERATOR_PASSWORD) {
			return fail(503, { error: 'Operator login is not configured (OT_OPERATOR_PASSWORD unset)' });
		}
		if (password !== env.OT_OPERATOR_PASSWORD) {
			return fail(401, { error: 'Wrong password' });
		}
		const secret = operatorCookieSecret({ OT_OPERATOR_COOKIE_SECRET: env.OT_OPERATOR_COOKIE_SECRET, OT_OPERATOR_PASSWORD: env.OT_OPERATOR_PASSWORD })!;
		cookies.set(OPERATOR_COOKIE, signOperatorCookie(secret, { userId: String(locals.user._id) }), {
			path: OPERATOR_COOKIE_PATH,
			httpOnly: true,
			sameSite: 'lax',
			secure: url.protocol === 'https:',
			maxAge: OPERATOR_TTL_SECONDS
		});
		throw redirect(303, next);
	}
};
