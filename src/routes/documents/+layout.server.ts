import { redirect } from '@sveltejs/kit';
import { hasPermission } from '$lib/server/permissions';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');

	return {
		user: JSON.parse(JSON.stringify({ ...locals.user, id: (locals.user as any)._id })),
		permissions: {
			canRead: hasPermission(locals.user, 'document:read'),
			canWrite: hasPermission(locals.user, 'document:write'),
			canApprove: hasPermission(locals.user, 'document:approve'),
			canTrain: hasPermission(locals.user, 'document:train')
		}
	};
};
