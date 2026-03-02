import { redirect } from '@sveltejs/kit';
import { connectDB, Equipment } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	await connectDB();

	const equipment = await Equipment.find({
		equipmentType: { $in: ['oven', 'incubator', 'heater'] }
	}).sort({ name: 1 }).lean();

	return {
		equipment: equipment.map((e: any) => ({
			id: e._id,
			name: e.name ?? null,
			type: e.equipmentType ?? null,
			status: e.status ?? 'active',
			currentTemperature: e.currentTemperatureC ?? null,
			targetTemperature: e.temperatureMaxC ?? null
		}))
	};
};
