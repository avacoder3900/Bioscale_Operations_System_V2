export const config = { maxDuration: 60 };
import { fail } from '@sveltejs/kit';
import { connectDB, generateId, Equipment, EquipmentLocation, AuditLog } from '$lib/server/db';
import { isAdmin } from '$lib/server/permissions';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	try {
		await connectDB();

		const [locations, equipment] = await Promise.all([
			EquipmentLocation.find().sort({ displayName: 1 }).lean(),
			Equipment.find().sort({ name: 1 }).lean()
		]);

		return {
			locations: (locations as any[]).map((loc: any) => ({
				id: loc._id,
				barcode: loc.barcode ?? null,
				locationType: loc.locationType ?? null,
				displayName: loc.displayName ?? null,
				isActive: loc.isActive ?? true,
				capacity: loc.capacity ?? null,
				notes: loc.notes ?? null,
				createdAt: loc.createdAt?.toISOString?.() ?? loc.createdAt ?? null,
				occupantCount: (loc.currentPlacements ?? []).length,
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
			equipmentSensors: (equipment as any[]).map((e: any) => ({
				equipmentId: e._id,
				name: e.name ?? null,
				equipmentType: e.equipmentType ?? null,
				status: e.status ?? 'active',
				currentTemperatureC: e.currentTemperatureC ?? null,
				temperatureMinC: e.temperatureMinC ?? null,
				temperatureMaxC: e.temperatureMaxC ?? null,
				lastTemperatureReadAt: e.lastTemperatureReadAt ?? null,
				mocreoDeviceId: e.mocreoDeviceId ?? null,
				mocreoAssetId: e.mocreoAssetId ?? null
			})),
			isAdmin: isAdmin(locals.user)
		};
	} catch (err) {
		console.error('[EQUIPMENT fridges-ovens] Load error:', err instanceof Error ? err.message : err);
		return {
			locations: [],
			equipmentSensors: [],
			isAdmin: isAdmin(locals.user)
		};
	}
};

export const actions: Actions = {
	createLocation: async ({ request, locals }) => {
		if (!isAdmin(locals.user)) return fail(403, { error: 'Admin access required' });
		await connectDB();

		const data = await request.formData();
		const displayName = data.get('displayName')?.toString()?.trim();
		const barcode = data.get('barcode')?.toString()?.trim();
		const locationType = data.get('locationType')?.toString();
		const capacityStr = data.get('capacity')?.toString();
		const notes = data.get('notes')?.toString()?.trim() || undefined;

		if (!displayName) return fail(400, { error: 'Display name is required' });
		if (!barcode) return fail(400, { error: 'Barcode is required' });
		if (!locationType || !['fridge', 'oven'].includes(locationType)) {
			return fail(400, { error: 'Invalid location type' });
		}

		const capacity = capacityStr ? parseInt(capacityStr, 10) : undefined;

		const id = generateId();
		await EquipmentLocation.create({
			_id: id,
			displayName,
			barcode,
			locationType,
			isActive: true,
			capacity,
			notes
		});

		await AuditLog.create({
			_id: generateId(),
			action: 'create',
			resourceType: 'equipment_location',
			resourceId: id,
			userId: locals.user._id,
			username: locals.user.username,
			timestamp: new Date(),
			details: { displayName, barcode, locationType, capacity, notes }
		});

		return { success: true, message: `${displayName} registered successfully` };
	},

	updateLocation: async ({ request, locals }) => {
		if (!isAdmin(locals.user)) return fail(403, { error: 'Admin access required' });
		await connectDB();

		const data = await request.formData();
		const id = data.get('id')?.toString();
		if (!id) return fail(400, { error: 'Location ID is required' });

		const displayName = data.get('displayName')?.toString()?.trim();
		const capacityStr = data.get('capacity')?.toString();
		const notes = data.get('notes')?.toString()?.trim();
		const isActiveStr = data.get('isActive')?.toString();

		const update: Record<string, any> = {};
		if (displayName) update.displayName = displayName;
		if (capacityStr) update.capacity = parseInt(capacityStr, 10);
		if (notes !== undefined) update.notes = notes || undefined;
		if (isActiveStr !== undefined) update.isActive = isActiveStr === 'true';

		const doc = await EquipmentLocation.findByIdAndUpdate(id, update, { new: true }).lean();
		if (!doc) return fail(404, { error: 'Location not found' });

		await AuditLog.create({
			_id: generateId(),
			action: 'update',
			resourceType: 'equipment_location',
			resourceId: id,
			userId: locals.user._id,
			username: locals.user.username,
			timestamp: new Date(),
			details: update
		});

		return { success: true, message: 'Location updated' };
	},

	deleteLocation: async ({ request, locals }) => {
		if (!isAdmin(locals.user)) return fail(403, { error: 'Admin access required' });
		await connectDB();

		const data = await request.formData();
		const id = data.get('id')?.toString();
		if (!id) return fail(400, { error: 'Location ID is required' });

		const doc = await EquipmentLocation.findByIdAndUpdate(id, { isActive: false }, { new: true }).lean();
		if (!doc) return fail(404, { error: 'Location not found' });

		await AuditLog.create({
			_id: generateId(),
			action: 'deactivate',
			resourceType: 'equipment_location',
			resourceId: id,
			userId: locals.user._id,
			username: locals.user.username,
			timestamp: new Date(),
			details: { deactivated: true }
		});

		return { success: true, message: 'Location deactivated' };
	}
};
