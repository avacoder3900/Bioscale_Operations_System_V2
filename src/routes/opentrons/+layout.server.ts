import { redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	return { user: { id: locals.user._id, username: locals.user.username } };
};
