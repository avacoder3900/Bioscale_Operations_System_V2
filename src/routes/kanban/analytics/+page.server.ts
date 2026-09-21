/**
 * KB2-15 — the Analytics page is retired; its person-free charts live on
 * /kanban/flow (the per-assignee table and creator-mix donut were deleted per
 * KB2-00 decision #12). This stub keeps old bookmarks/links landing on the
 * consolidated page, range preserved.
 */
import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ url }) => {
	const range = url.searchParams.get('range');
	redirect(302, `/kanban/flow${range ? `?range=${encodeURIComponent(range)}` : ''}`);
};
