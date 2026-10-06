import { redirect } from '@sveltejs/kit';
import { hasPermission, isAdmin } from '$lib/server/permissions';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');

	const canManageUsers = hasPermission(locals.user, 'user:read');
	const canManageRoles = hasPermission(locals.user, 'role:read');
	const canManageAdmin = hasPermission(locals.user, 'admin:full');
	// Badge Portal (BADGE-SYSTEM_PLAN.md §17.1): admin only — admin:full or admin:users.
	const canManageBadges = isAdmin(locals.user);

	if (!canManageUsers && !canManageRoles && !canManageAdmin && !canManageBadges) {
		redirect(302, '/');
	}

	return { canManageUsers, canManageRoles, canManageAdmin, canManageBadges };
};

export const config = { maxDuration: 60 };
