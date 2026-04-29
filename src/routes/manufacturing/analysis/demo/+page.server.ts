/**
 * /manufacturing/analysis/demo — fabricated-data twin of the real analytics
 * page, reconfigured as a training experience.
 *
 * Nothing here writes to Mongo. Data comes from src/lib/server/analytics/
 * demo-seed.ts. All form actions are no-ops. Entire page is gated by a
 * cookie-based password check ("processadmin"), with a 24-hour session.
 */
import { redirect, fail } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { getDemoAnalyticsPageData } from '$lib/server/analytics/demo-seed.js';
import type { PageServerLoad, Actions } from './$types';

export const config = { maxDuration: 10 };

const TRAINING_COOKIE = 'analysis-demo-training';
const TRAINING_PASSWORD = 'processadmin';
const TRAINING_COOKIE_MAX_AGE = 60 * 60 * 24; // 24 hours

export const load: PageServerLoad = async ({ locals, cookies }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');

	// Gate: if the cookie isn't present, show the password form only and
	// skip the heavy demo-seed generation.
	const unlocked = cookies.get(TRAINING_COOKIE) === 'unlocked';
	if (!unlocked) {
		return { locked: true } as const;
	}

	return {
		locked: false as const,
		...getDemoAnalyticsPageData()
	};
};

const demoNoop = async () => fail(200, { error: 'Demo training mode — changes are not persisted to Mongo.' });

export const actions: Actions = {
	// Unlock the training session with the shared password.
	unlock: async ({ request, cookies }) => {
		const form = await request.formData();
		const password = form.get('password')?.toString() ?? '';
		if (password !== TRAINING_PASSWORD) {
			return fail(401, { error: 'Wrong password.' });
		}
		cookies.set(TRAINING_COOKIE, 'unlocked', {
			path: '/manufacturing/analysis/demo',
			maxAge: TRAINING_COOKIE_MAX_AGE,
			httpOnly: true,
			sameSite: 'strict',
			secure: true
		});
		return { success: true, unlocked: true };
	},

	lock: async ({ cookies }) => {
		cookies.delete(TRAINING_COOKIE, { path: '/manufacturing/analysis/demo' });
		return { success: true, locked: true };
	},

	// No-op form actions — the demo UI has the same action names as the real
	// page but none of them touch Mongo.
	createManualEvent: demoNoop,
	deleteManualEvent: demoNoop,
	saveFmea: demoNoop,
	deleteFmea: demoNoop,
	saveSpecLimit: demoNoop,
	retireSpecLimit: demoNoop,
	ackSignal: demoNoop,
	closeSignal: demoNoop,
	dismissSignal: demoNoop,
	saveCauseEffect: demoNoop
};
