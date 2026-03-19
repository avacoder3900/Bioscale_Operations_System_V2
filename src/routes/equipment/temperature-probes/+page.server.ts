export const config = { maxDuration: 60 };
import { connectDB, Equipment } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	try {
		await connectDB();
		const equipment = await Equipment.find().sort({ name: 1 }).lean();

		return {
			probes: (equipment as any[]).map((e: any) => ({
				id: e._id,
				name: e.name ?? null,
				deviceId: e.mocreoDeviceId ?? null,
				currentTemperature: e.currentTemperatureC ?? null,
				lastReadingAt: e.lastTemperatureReadAt ?? null,
				status: e.status ?? 'active',
				linkedEquipmentId: e._id,
				linkedEquipmentName: e.name ?? null
			}))
		};
	} catch (err) {
		console.error('[EQUIPMENT temperature-probes] Load error:', err instanceof Error ? err.message : err);
		return { probes: [] };
	}
};
