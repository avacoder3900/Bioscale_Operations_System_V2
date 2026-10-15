import { redirect } from '@sveltejs/kit';
import { loadWellIssueHeatmap } from '$lib/server/manufacturing/reagent-well-heatmap';
import type { PageServerLoad } from './$types';

export const config = { maxDuration: 60 };

/**
 * Reagent well-issue history (2026-10-06) — every mistake logged on the
 * run-page well tracker as a per-robot/deck heatmap plus the per-run list.
 * The roll-up lives in $lib/server/manufacturing/reagent-well-heatmap so the
 * Robots page can show the same card inline per robot (2026-10-08).
 */
export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) redirect(302, '/login');
	return loadWellIssueHeatmap({ days: Number(url.searchParams.get('days') ?? 30), robotId: url.searchParams.get('robot') });
};
