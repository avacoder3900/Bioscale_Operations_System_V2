import { redirect } from '@sveltejs/kit';
import { hasPermission } from '$lib/server/permissions';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');

	return {
		user: JSON.parse(JSON.stringify(locals.user)),
		permissions: {
			canReadInstructions: hasPermission(locals.user, 'workInstruction:read'),
			canWriteInstructions: hasPermission(locals.user, 'workInstruction:write'),
			canApproveInstructions: hasPermission(locals.user, 'workInstruction:approve'),
			canReadDocuments: hasPermission(locals.user, 'documentRepo:read'),
			canWriteDocuments: hasPermission(locals.user, 'documentRepo:write'),
			canReadProductionRuns: hasPermission(locals.user, 'productionRun:read')
		}
	};
};
