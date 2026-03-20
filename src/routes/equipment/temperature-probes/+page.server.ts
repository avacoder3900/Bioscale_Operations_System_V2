export const config = { maxDuration: 60 };
import { connectDB, Equipment } from '$lib/server/db';
import { isAdmin } from '$lib/server/permissions';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	try {
		await connectDB();
		const equipment = await Equipment.find().sort({ name: 1 }).lean();

		return {
			sensors: (equipment as any[]).map((e: any) => ({
				equipmentId: e._id,
				name: e.name ?? null,
				equipmentType: e.equipmentType ?? 'unknown',
				mocreoDeviceId: e.mocreoDeviceId ?? null,
				currentTemperature: e.currentTemperatureC ?? null,
				targetTemperature: e.temperatureMaxC ?? null,
				lastReadingAt: e.lastTemperatureReadAt ?? null,
				status: e.status ?? 'active',
				isActive: e.isActive ?? true
			})),
			recentReadings: [],
			isAdmin: isAdmin(locals.user)
		};
	} catch (err) {
		console.error('[TEMP PROBES] Load error:', err instanceof Error ? err.message : err);
		return { sensors: [], recentReadings: [], isAdmin: isAdmin(locals.user) };
	}
};
