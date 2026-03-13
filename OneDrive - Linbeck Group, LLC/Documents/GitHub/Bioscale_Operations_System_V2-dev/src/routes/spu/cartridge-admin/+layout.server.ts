import { redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'cartridgeAdmin:read');
	return { user: locals.user };
};
