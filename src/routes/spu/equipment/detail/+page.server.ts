import { connectDB, Equipment } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	await connectDB();
	const equipment = await Equipment.find().sort({ name: 1 }).lean();

	return {
		equipment: equipment.map((e: any) => ({
			id: e._id,
			name: e.name ?? null,
			type: e.equipmentType ?? null,
			serialNumber: null,
			status: e.status ?? 'active',
			location: e.location ?? null,
			lastMaintenanceAt: null,
			nextMaintenanceAt: null,
			notes: e.notes ?? null
		}))
	};
};
