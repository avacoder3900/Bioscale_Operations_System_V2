/**
 * /manufacturing/analysis/demo — fabricated-data twin of the real analytics page.
 *
 * Nothing here writes to Mongo. The load function returns pre-generated demo
 * data from src/lib/server/analytics/demo-seed.ts. All form actions are
 * no-ops that return a "demo mode — not persisted" notice, so the forms on
 * the copied UI still render and show feedback without any side effects.
 */
import { redirect, fail } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { getDemoAnalyticsPageData } from '$lib/server/analytics/demo-seed.js';
import type { PageServerLoad, Actions } from './$types';

export const config = { maxDuration: 10 };

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	return getDemoAnalyticsPageData();
};

// Every action is a no-op. The real /manufacturing/analysis page has the same
// action names and writes to Mongo; here we intercept them and return a
// demo-mode notice so operators can click through the forms without touching
// real data.
const demoNoop = async () => fail(200, { error: 'Demo mode — changes are not persisted to Mongo.' });

export const actions: Actions = {
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
