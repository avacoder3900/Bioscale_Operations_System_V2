import { requirePermission } from '$lib/server/permissions';
import { connectDB } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();
	return {
		instruments: [
			{ name: 'Magnetometer', path: '/spu/validation/magnetometer' },
			{ name: 'Spectrophotometer', path: '/spu/validation/spectrophotometer' },
			{ name: 'Thermocouple', path: '/spu/validation/thermocouple' }
		]
	};
};
