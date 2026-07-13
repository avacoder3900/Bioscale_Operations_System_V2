import { redirect } from '@sveltejs/kit';
import { hasPermission } from '$lib/server/permissions';
import { getQmsState } from '$lib/server/qms';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');

	const canManageUsers = hasPermission(locals.user, 'user:read');
	const canManageRoles = hasPermission(locals.user, 'role:read');
	// QMS control is gated on admin:full so it's reachable by the seeded Admin role
	// without first introducing a new qms:* permission.
	const canManageQms = hasPermission(locals.user, 'admin:full');

	if (!canManageUsers && !canManageRoles && !canManageQms) {
		redirect(302, '/spu');
	}

	const qms = await getQmsState();

	return {
		canManageUsers,
		canManageRoles,
		canManageQms,
		qmsPhase: qms.phase,
		regulated: qms.regulated
	};
};
