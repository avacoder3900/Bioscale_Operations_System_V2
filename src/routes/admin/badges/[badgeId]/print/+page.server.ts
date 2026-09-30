/**
 * Print one badge (BADGE-SYSTEM_PLAN.md §17.2) — a CR80 card with the name,
 * the QR and the code. Admin only. Opening the page counts as a print.
 */
import { error, redirect } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db';
import { isAdmin } from '$lib/server/permissions';
import { getBadge, bumpPrintCount } from '$lib/server/services/badge-service';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	if (!locals.user) redirect(302, '/login');
	if (!isAdmin(locals.user)) throw error(403, 'Admin access required');
	await connectDB();
	const badge = await getBadge(params.badgeId);
	if (!badge) throw error(404, 'Badge not found');
	if (badge.status === 'active') await bumpPrintCount(badge.badgeId);
	return { badge };
};
