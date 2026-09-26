import { redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { requirePermission, hasPermission } from '$lib/server/permissions';
import { connectDB, OpentronsRobot } from '$lib/server/db';
import { OPERATOR_COOKIE, operatorCookieSecret, verifyOperatorCookie } from '$lib/server/opentrons/operator-cookie';
import type { LayoutServerLoad } from './$types';

/**
 * The clone's only server responsibilities (OT2-TAILNET-5 §7.8): BIMS login +
 * manufacturing:read, the operator-password gate, and the robot list from
 * Mongo. Every robot call happens in the browser over the robot session.
 */
export const load: LayoutServerLoad = async ({ locals, url, cookies }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');

	// Operator-admin gate — extra password wall for the clone. The cookie is a
	// signed, expiring value bound to this BIMS user; a hand-set value fails.
	const isLoginPage = url.pathname === '/opentrons-clone/operator-login';
	const authed = verifyOperatorCookie(cookies.get(OPERATOR_COOKIE), operatorCookieSecret({ OT_OPERATOR_COOKIE_SECRET: env.OT_OPERATOR_COOKIE_SECRET, OT_OPERATOR_PASSWORD: env.OT_OPERATOR_PASSWORD }), {
		userId: String(locals.user._id)
	});
	if (!authed && !isLoginPage) {
		const next = encodeURIComponent(url.pathname + url.search);
		throw redirect(303, `/opentrons-clone/operator-login?next=${next}`);
	}

	let robots: Array<{ _id: string; name: string; ip: string; port?: number }> = [];
	if (authed) {
		await connectDB();
		robots = JSON.parse(
			JSON.stringify(
				await OpentronsRobot.find({ isActive: true }).select('_id name ip port').sort({ name: 1 }).lean()
			)
		);
	}

	return {
		user: { id: locals.user._id, username: locals.user.username },
		operatorAuthed: authed,
		// Robot actions on the tailnet line don't pass a BIMS route, so the page
		// applies the manufacturing:write rule itself (the relay enforces it too).
		canWrite: hasPermission(locals.user, 'manufacturing:write'),
		robots
	};
};
