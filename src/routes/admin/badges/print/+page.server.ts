/**
 * Batch print (BADGE-SYSTEM_PLAN.md §17.2) — every badge whose id is in
 * `?ids=a,b,c`, laid out as CR80 cards on a cut sheet. Admin only. Opening the
 * sheet counts as one print for each active badge on it.
 */
import { error, redirect } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db';
import { isAdmin } from '$lib/server/permissions';
import { getBadges, bumpPrintCount } from '$lib/server/services/badge-service';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) redirect(302, '/login');
	if (!isAdmin(locals.user)) throw error(403, 'Admin access required');
	const ids = Array.from(new Set((url.searchParams.get('ids') ?? '').split(',').map(s => s.trim()).filter(Boolean)));
	if (ids.length === 0) redirect(302, '/admin/badges');
	await connectDB();
	const badges = await getBadges(ids);
	if (badges.length === 0) throw error(404, 'None of the selected badges exist');
	await bumpPrintCount(badges.filter(b => b.status === 'active').map(b => b.badgeId));
	return { badges, missing: ids.length - badges.length };
};
