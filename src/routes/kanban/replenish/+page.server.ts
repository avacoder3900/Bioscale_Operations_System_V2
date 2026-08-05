/**
 * KB2-14 — the Replenish page is retired; the commitment ceremony lives on
 * Inventory (staging checkboxes + commit bar). The gate itself is unchanged
 * server-side (src/lib/server/kanban/replenish.ts). This stub keeps old
 * bookmarks/links landing on the ceremony's new home, board preserved.
 */
import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ url }) => {
	const board = url.searchParams.get('board');
	redirect(302, `/kanban/inventory${board === 'software' ? '?board=software' : ''}`);
};
