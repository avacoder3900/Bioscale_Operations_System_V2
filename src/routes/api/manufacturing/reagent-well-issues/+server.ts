/**
 * Reagent well-issue heatmap as JSON (2026-10-08) — what the Robots page's
 * inline heatmap card fetches when the operator opens it on a robot panel.
 * GET /api/manufacturing/reagent-well-issues?robot=<robotId>&days=30
 * Same roll-up as /manufacturing/cart-mfg/reagent-filling/well-issues.
 */
import { json, error } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { loadWellIssueHeatmap } from '$lib/server/manufacturing/reagent-well-heatmap';
import type { RequestHandler } from './$types';

export const config = { maxDuration: 30 };

export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:read');
	const heatmap = await loadWellIssueHeatmap({ days: Number(url.searchParams.get('days') ?? 30), robotId: url.searchParams.get('robot') });
	return json(heatmap);
};
