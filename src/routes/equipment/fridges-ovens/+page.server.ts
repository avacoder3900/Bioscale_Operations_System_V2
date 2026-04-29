export const config = { maxDuration: 60 };
import { fail } from '@sveltejs/kit';
import { connectDB, generateId, Equipment, EquipmentLocation, AuditLog, CartridgeRecord, TemperatureReading } from '$lib/server/db';
import { isAdmin, requirePermission } from '$lib/server/permissions';
import { getCheckedOutCartridgeIds } from '$lib/server/checkout-utils';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'equipment:read');
	try {
		await connectDB();

		// Exclude manually checked-out cartridges from fridge occupancy
		const checkedOutIds = await getCheckedOutCartridgeIds();

		const [equipmentDocs, locationDocs] = await Promise.all([
			Equipment.find({ equipmentType: { $in: ['fridge', 'oven'] } }).sort({ name: 1 }).lean(),
			EquipmentLocation.find().sort({ displayName: 1 }).lean()
		]);

		// Build a map of parentEquipmentId -> child locations
		const childMap = new Map<string, any[]>();
		for (const loc of locationDocs as any[]) {
			if (loc.parentEquipmentId) {
				const children = childMap.get(loc.parentEquipmentId) ?? [];
				children.push(loc);
				childMap.set(loc.parentEquipmentId, children);
			}
		}

		// Fetch actual cartridge records stored in fridges (for counts + detail display)
		const storedCartridges = await CartridgeRecord.find({
			_id: { $nin: checkedOutIds },
			$or: [
				{ 'waxStorage.location': { $exists: true }, status: 'wax_stored' },
				{ 'storage.fridgeName': { $exists: true }, status: 'stored' }
			]
		}).select({
			_id: 1, status: 1,
			'reagentFilling.assayType': 1,
			'waxQc.status': 1,
			'waxStorage.location': 1, 'waxStorage.recordedAt': 1, 'waxStorage.operator': 1,
			'storage.fridgeName': 1, 'storage.recordedAt': 1, 'storage.operator': 1,
			updatedAt: 1
		}).lean().catch(() => []) as any[];

		// Group cartridges by fridge key and build occupant counts
		const occupantMap = new Map<string, number>();
		const cartridgesByFridge = new Map<string, any[]>();
		for (const c of storedCartridges) {
			const isWax = c.status === 'wax_stored' && c.waxStorage?.location;
			const key = isWax ? c.waxStorage.location : c.storage?.fridgeName;
			if (!key) continue;
			occupantMap.set(key, (occupantMap.get(key) ?? 0) + 1);
			if (!cartridgesByFridge.has(key)) cartridgesByFridge.set(key, []);
			const storedAt = isWax ? c.waxStorage?.recordedAt : c.storage?.recordedAt;
			const operator = isWax ? c.waxStorage?.operator?.username : c.storage?.operator?.username;
			cartridgesByFridge.get(key)!.push({
				id: String(c._id),
				status: c.status,
				assayType: c.reagentFilling?.assayType?.name ?? null,
				waxQcStatus: c.waxQc?.status ?? null,
				storageType: isWax ? 'wax' : 'reagent',
				storedAt: storedAt ? new Date(storedAt).toISOString() : null,
				operator: operator ?? null
			});
		}

		// Helper: compute total occupants for an equipment and all its child locations
		function getOccupantCount(equip: any, children: any[]): number {
			let total = 0;
			// Match by equipment name and barcode
			const keys = [equip.barcode, equip.name].filter(Boolean);
			for (const key of keys) {
				total += occupantMap.get(key) ?? 0;
			}
			// Also count from child location barcodes and display names
			for (const child of children) {
				const childKeys = [child.barcode, child.displayName].filter(Boolean);
				for (const key of childKeys) {
					total += occupantMap.get(key) ?? 0;
				}
			}
			return total;
		}

		// Helper: aggregate capacity from children (or use equipment's own capacity)
		function getCapacity(equip: any, children: any[]): number | null {
			if (equip.capacity) return equip.capacity;
			if (children.length === 0) return null;
			let total = 0;
			let hasAny = false;
			for (const child of children) {
				if (child.capacity) { total += child.capacity; hasAny = true; }
			}
			return hasAny ? total : null;
		}

		// Return Equipment records as the primary "locations" list
		// Includes ALL equipment types: fridge, oven, robot, deck, cooling_tray
		const locations = (equipmentDocs as any[])
			.map((equip: any) => {
				const children = childMap.get(String(equip._id)) ?? [];
				const capacity = getCapacity(equip, children);
				return {
					id: String(equip._id),
					barcode: equip.barcode ?? null,
					locationType: equip.equipmentType ?? null,
					displayName: equip.name ?? null,
					isActive: equip.status !== 'offline',
					capacity,
					notes: equip.notes ?? null,
					createdAt: equip.createdAt?.toISOString?.() ?? equip.createdAt ?? null,
					occupantCount: getOccupantCount(equip, children),
					currentPlacements: [],
					cartridges: (() => {
						const keys = [equip.barcode, equip.name].filter(Boolean);
						for (const child of children) {
							if (child.barcode) keys.push(child.barcode);
							if (child.displayName) keys.push(child.displayName);
						}
						const all: any[] = [];
						for (const k of keys) {
							const carts = cartridgesByFridge.get(k);
							if (carts) all.push(...carts);
						}
						return all;
					})()
				};
			});

		// Also include any orphan EquipmentLocations without a parent (backward compat)
		const parentedIds = new Set<string>();
		for (const loc of locationDocs as any[]) {
			if (loc.parentEquipmentId) parentedIds.add(String(loc._id));
		}
		for (const loc of locationDocs as any[]) {
			if (!loc.parentEquipmentId) {
				const key = loc.barcode ?? loc.displayName ?? String(loc._id);
				locations.push({
					id: loc._id,
					barcode: loc.barcode ?? null,
					locationType: loc.locationType ?? null,
					displayName: loc.displayName ?? null,
					isActive: loc.isActive ?? true,
					capacity: loc.capacity ?? null,
					notes: loc.notes ?? null,
					createdAt: loc.createdAt?.toISOString?.() ?? loc.createdAt ?? null,
					occupantCount: occupantMap.get(key) ?? occupantMap.get(loc.displayName ?? '') ?? 0,
					cartridges: cartridgesByFridge.get(key) ?? cartridgesByFridge.get(loc.displayName ?? '') ?? [],
					currentPlacements: (loc.currentPlacements ?? []).map((p: any) => ({
						id: p._id,
						itemType: p.itemType ?? null,
						itemId: p.itemId ?? null,
						placedBy: p.placedBy ?? null,
						placedAt: p.placedAt ?? null,
						runId: p.runId ?? null,
						notes: p.notes ?? null
					}))
				});
			}
		}

		// Sort locations by displayName
		locations.sort((a, b) => (a.displayName ?? '').localeCompare(b.displayName ?? ''));

		return {
			locations,
			equipmentSensors: (equipmentDocs as any[])
				.filter((e: any) => e.equipmentType === 'fridge' || e.equipmentType === 'oven') // temperature sensors are fridge/oven only
				.map((e: any) => ({
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
		requirePermission(locals.user, 'equipment:write');
		if (!isAdmin(locals.user)) return fail(403, { error: 'Admin access required' });
		await connectDB();

		const data = await request.formData();
		const displayName = data.get('displayName')?.toString()?.trim();
		const barcode = data.get('barcode')?.toString()?.trim();
		const locationType = data.get('locationType')?.toString();
		const capacityStr = data.get('capacity')?.toString();
		const notes = data.get('notes')?.toString()?.trim() || undefined;

		if (!displayName) return fail(400, { error: 'Display name is required' });
		if (!locationType || !['fridge', 'oven', 'robot', 'deck', 'cooling_tray'].includes(locationType)) {
			return fail(400, { error: 'Invalid equipment type' });
		}

		const capacity = capacityStr ? parseInt(capacityStr, 10) : undefined;

		// Create a parent Equipment record (the fridge/oven itself)
		const equipId = generateId();
		await Equipment.create({
			_id: equipId,
			name: displayName,
			barcode,
			equipmentType: locationType,
			status: 'active',
			capacity,
			notes
		});

		await AuditLog.create({
			_id: generateId(),
			action: 'INSERT',
			tableName: 'equipment',
			recordId: equipId,
			changedBy: locals.user?.username ?? locals.user?._id,
			changedAt: new Date(),
			newData: {}
		});

		return { success: true, message: `${displayName} registered successfully` };
	},

	updateLocation: async ({ request, locals }) => {
		requirePermission(locals.user, 'equipment:write');
		if (!isAdmin(locals.user)) return fail(403, { error: 'Admin access required' });
		await connectDB();

		const data = await request.formData();
		const id = data.get('id')?.toString();
		if (!id) return fail(400, { error: 'Location ID is required' });

		const displayName = data.get('displayName')?.toString()?.trim();
		const capacityStr = data.get('capacity')?.toString();
		const notes = data.get('notes')?.toString()?.trim();
		const isActiveStr = data.get('isActive')?.toString();

		// Try Equipment first, then EquipmentLocation
		const equip = await Equipment.findById(id).lean();
		if (equip) {
			const update: Record<string, any> = {};
			if (displayName) update.name = displayName;
			if (capacityStr) update.capacity = parseInt(capacityStr, 10);
			if (notes !== undefined) update.notes = notes || undefined;
			if (isActiveStr !== undefined) update.status = isActiveStr === 'true' ? 'active' : 'offline';

			await Equipment.findByIdAndUpdate(id, update);
		} else {
			const update: Record<string, any> = {};
			if (displayName) update.displayName = displayName;
			if (capacityStr) update.capacity = parseInt(capacityStr, 10);
			if (notes !== undefined) update.notes = notes || undefined;
			if (isActiveStr !== undefined) update.isActive = isActiveStr === 'true';

			const doc = await EquipmentLocation.findByIdAndUpdate(id, update, { new: true }).lean();
			if (!doc) return fail(404, { error: 'Location not found' });
		}

		await AuditLog.create({
			_id: generateId(),
			tableName: 'equipment',
			recordId: id,
			action: 'UPDATE',
			changedBy: locals.user?.username ?? locals.user?._id,
			changedAt: new Date()
		});

		return { success: true, message: 'Location updated' };
	},

	mapSensor: async ({ request, locals }) => {
		if (!isAdmin(locals.user)) return fail(403, { error: 'Admin access required' });
		await connectDB();

		const data = await request.formData();
		const equipmentId = data.get('equipmentId')?.toString();
		const mocreoDeviceId = data.get('mocreoDeviceId')?.toString() || null;

		if (!equipmentId) return fail(400, { error: 'Equipment ID is required' });

		// Clear previous mapping if another equipment had this sensor
		if (mocreoDeviceId) {
			await Equipment.updateMany(
				{ mocreoDeviceId, _id: { $ne: equipmentId } },
				{ $unset: { mocreoDeviceId: 1 } }
			);
		}

		const updateOp = mocreoDeviceId
			? { mocreoDeviceId }
			: { $unset: { mocreoDeviceId: 1 } };
		await Equipment.findByIdAndUpdate(equipmentId, updateOp);

		await AuditLog.create({
			_id: generateId(),
			action: 'UPDATE',
			tableName: 'equipment',
			recordId: equipmentId,
			changedBy: locals.user?.username ?? locals.user?._id,
			changedAt: new Date(),
			newData: { mocreoDeviceId }
		});

		return { success: true, message: 'Sensor mapping updated' };
	},

	deleteLocation: async ({ request, locals }) => {
		requirePermission(locals.user, 'equipment:write');
		if (!isAdmin(locals.user)) return fail(403, { error: 'Admin access required' });
		await connectDB();

		const data = await request.formData();
		const id = data.get('id')?.toString();
		if (!id) return fail(400, { error: 'Location ID is required' });

		// Try Equipment first (hard delete), then EquipmentLocation
		const equip = await Equipment.findByIdAndDelete(id).lean();
		if (!equip) {
			const doc = await EquipmentLocation.findByIdAndDelete(id).lean();
			if (!doc) return fail(404, { error: 'Location not found' });
		}

		await AuditLog.create({
			_id: generateId(),
			action: 'DELETE',
			tableName: 'equipment',
			recordId: id,
			changedBy: locals.user?.username ?? locals.user?._id,
			changedAt: new Date(),
			newData: {}
		});

		return { success: true, message: 'Equipment deleted' };
	}
};
