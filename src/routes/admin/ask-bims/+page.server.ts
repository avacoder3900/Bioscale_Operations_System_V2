import { redirect } from '@sveltejs/kit';
import { hasPermission, requirePermission } from '$lib/server/permissions';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'admin:full');
	return {
		canUseOpus: hasPermission(locals.user, 'admin:full')
	};
};

export const config = { maxDuration: 60 };
