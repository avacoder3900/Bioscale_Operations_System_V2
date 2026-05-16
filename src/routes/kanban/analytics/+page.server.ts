import { redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { loadAnalyticsData, parseRange } from '$lib/server/kanban/analytics';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url, depends }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'kanban:read');

	depends('kanban:analytics');

	const range = parseRange(url.searchParams.get('range'));
	const analytics = await loadAnalyticsData(range);

	return { analytics };
};

export const config = { maxDuration: 60 };
