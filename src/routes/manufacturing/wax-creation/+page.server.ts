import { fail } from '@sveltejs/kit';
import { connectDB, AuditLog, generateId } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'manufacturing:read');
	return {};
};

export const actions: Actions = {
	save: async ({ request, locals }) => {
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();

		const data = await request.formData();
		const nanodecaneWeight = parseFloat(data.get('nanodecaneWeight')?.toString() || '0');
		const actualWaxWeight = parseFloat(data.get('actualWaxWeight')?.toString() || '0');
		const actualTubeCount = parseInt(data.get('actualTubeCount')?.toString() || '0', 10);
		const targetWaxWeight = parseFloat(data.get('targetWaxWeight')?.toString() || '0');
		const expectedTubes = parseInt(data.get('expectedTubes')?.toString() || '0', 10);

		if (!nanodecaneWeight || !actualWaxWeight || !actualTubeCount) {
			return fail(400, { error: 'All fields are required' });
		}

		const batchId = generateId();

		await AuditLog.create({
			_id: generateId(),
			action: 'create',
			resourceType: 'wax_creation_batch',
			resourceId: batchId,
			userId: locals.user!._id,
			username: locals.user!.username,
			timestamp: new Date(),
			details: {
				nanodecaneWeight,
				targetWaxWeight,
				actualWaxWeight,
				expectedTubes,
				actualTubeCount
			}
		});

		return { success: true, batchId };
	}
};
