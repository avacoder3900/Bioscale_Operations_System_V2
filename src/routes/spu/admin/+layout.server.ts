import { redirect } from '@sveltejs/kit';
import { hasPermission } from '$lib/server/permissions';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');

	const canManageUsers = hasPermission(locals.user, 'user:read');
	const canManageRoles = hasPermission(locals.user, 'role:read');

	if (!canManageUsers && !canManageRoles) {
		redirect(302, '/spu');
	}

	return { canManageUsers, canManageRoles };
};
