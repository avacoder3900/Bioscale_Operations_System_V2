import { connectDB, Equipment, EquipmentLocation } from '$lib/server/db';
import { isAdmin, requirePermission } from '$lib/server/permissions';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'equipment:read');
	await connectDB();

	const [locations, equipment] = await Promise.all([
		EquipmentLocation.find({ isActive: true }).sort({ displayName: 1 }).lean(),
		Equipment.find().sort({ name: 1 }).lean()
	]);

	return {
		locations: locations.map((loc: any) => ({
			id: loc._id,
			barcode: loc.barcode ?? null,
			locationType: loc.locationType ?? null,
			displayName: loc.displayName ?? null,
			isActive: loc.isActive,
			capacity: loc.capacity ?? null,
			notes: loc.notes ?? null,
			currentPlacements: (loc.currentPlacements ?? []).map((p: any) => ({
				id: p._id,
				itemType: p.itemType ?? null,
				itemId: p.itemId ?? null,
				placedBy: p.placedBy ?? null,
				placedAt: p.placedAt ?? null,
				runId: p.runId ?? null,
				notes: p.notes ?? null
			}))
		})),
		equipmentSensors: equipment.map((e: any) => ({
			id: e._id,
			name: e.name ?? null,
			type: e.equipmentType ?? null,
			currentTemperature: e.currentTemperatureC ?? null,
			targetTemperature: e.temperatureMaxC ?? null,
			status: e.status ?? 'active',
			lastReadingAt: e.lastTemperatureReadAt ?? null
		})),
		isAdmin: isAdmin(locals.user)
	};
};
