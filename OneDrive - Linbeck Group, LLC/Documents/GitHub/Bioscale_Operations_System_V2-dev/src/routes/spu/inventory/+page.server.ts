import { redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'inventory:read');
	redirect(302, '/spu/inventory/transactions');
};
