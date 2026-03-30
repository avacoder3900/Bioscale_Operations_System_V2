import { redirect } from '@sveltejs/kit';
import { connectDB, CartridgeRecord, Equipment, EquipmentLocation } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	await connectDB();

	// Get parent fridges from Equipment collection
	const equipDocs = await Equipment.find({ equipmentType: 'fridge' }).sort({ name: 1 }).lean().catch(() => []);
	// Get child locations for each equipment
	const locationDocs = await EquipmentLocation.find({ locationType: 'fridge' }).lean().catch(() => []);

	// Build parent-to-children map
	const childMap = new Map<string, any[]>();
	const orphanLocations: any[] = [];
	for (const loc of locationDocs as any[]) {
		if (loc.parentEquipmentId) {
			const children = childMap.get(loc.parentEquipmentId) ?? [];
			children.push(loc);
			childMap.set(loc.parentEquipmentId, children);
		} else {
			orphanLocations.push(loc);
		}
	}

	// Build fridges list from Equipment + orphan locations
	const fridges: { id: string; displayName: string; barcode: string; isActive: boolean; matchKeys: string[] }[] = [];

	for (const equip of equipDocs as any[]) {
		const children = childMap.get(String(equip._id)) ?? [];
		// Match keys: equipment barcode/name + all child barcodes/displayNames
		const matchKeys: string[] = [];
		if (equip.barcode) matchKeys.push(equip.barcode);
		if (equip.name) matchKeys.push(equip.name);
		for (const child of children) {
			if (child.barcode) matchKeys.push(child.barcode);
			if (child.displayName) matchKeys.push(child.displayName);
		}
		fridges.push({
			id: String(equip._id),
			displayName: equip.name ?? equip.barcode ?? String(equip._id),
			barcode: equip.barcode ?? '',
			isActive: equip.status !== 'offline',
			matchKeys: [...new Set(matchKeys)]
		});
	}

	// Add orphan EquipmentLocations as standalone fridges
	for (const loc of orphanLocations) {
		const matchKeys: string[] = [];
		if (loc.barcode) matchKeys.push(loc.barcode);
		if (loc.displayName) matchKeys.push(loc.displayName);
		fridges.push({
			id: String(loc._id),
			displayName: loc.displayName ?? loc.barcode ?? String(loc._id),
			barcode: loc.barcode ?? '',
			isActive: loc.isActive ?? true,
			matchKeys: [...new Set(matchKeys)]
		});
	}

	// Get all stored cartridges (wax storage + reagent storage)
	const storedCartridges = await CartridgeRecord.find({
		$or: [
			{ 'waxStorage.location': { $exists: true, $ne: null }, status: 'wax_stored' },
			{ 'storage.fridgeName': { $exists: true, $ne: null }, status: { $in: ['stored', 'reagent_filled'] } }
		]
	}).select({
		_id: 1,
		status: 1,
		'waxStorage.location': 1,
		'waxStorage.recordedAt': 1,
		'waxStorage.operator': 1,
		'waxFilling.runId': 1,
		'storage.fridgeName': 1,
		'storage.recordedAt': 1,
		'storage.operator': 1,
		'reagentFilling.runId': 1,
		'reagentFilling.assayType': 1,
		createdAt: 1
	}).lean().catch(() => []);

	// Build a reverse lookup: matchKey -> fridgeIndex
	const keyToFridge = new Map<string, number>();
	for (let i = 0; i < fridges.length; i++) {
		for (const key of fridges[i].matchKeys) {
			keyToFridge.set(key, i);
		}
	}

	// Group cartridges by fridge
	const fridgeCartridges: any[][] = fridges.map(() => []);

	for (const c of storedCartridges as any[]) {
		const waxLoc = c.waxStorage?.location;
		const reagentLoc = c.storage?.fridgeName;

		if (waxLoc && keyToFridge.has(waxLoc)) {
			const idx = keyToFridge.get(waxLoc)!;
			fridgeCartridges[idx].push({
				id: String(c._id),
				type: 'wax_filled',
				phase: c.status ?? 'wax_stored',
				location: waxLoc,
				storedAt: c.waxStorage?.recordedAt ? new Date(c.waxStorage.recordedAt).toISOString() : null,
				operator: c.waxStorage?.operator?.username ?? null,
				runId: c.waxFilling?.runId ?? null,
				assayType: null
			});
		}

		if (reagentLoc && keyToFridge.has(reagentLoc)) {
			const idx = keyToFridge.get(reagentLoc)!;
			fridgeCartridges[idx].push({
				id: String(c._id),
				type: 'reagent_filled',
				phase: c.status ?? 'stored',
				location: reagentLoc,
				storedAt: c.storage?.recordedAt ? new Date(c.storage.recordedAt).toISOString() : null,
				operator: c.storage?.operator?.username ?? null,
				runId: c.reagentFilling?.runId ?? null,
				assayType: c.reagentFilling?.assayType?.name ?? null
			});
		}
	}

	const fridgeInventory = fridges.map((fridge, i) => {
		const cartridges = fridgeCartridges[i];
		return {
			location: fridge.barcode || fridge.displayName,
			fridgeId: fridge.id,
			displayName: fridge.displayName,
			isActive: fridge.isActive,
			cartridges,
			waxCount: cartridges.filter((c: any) => c.type === 'wax_filled').length,
			reagentCount: cartridges.filter((c: any) => c.type === 'reagent_filled').length,
			totalCount: cartridges.length
		};
	}).sort((a, b) => a.displayName.localeCompare(b.displayName));

	const totalWax = fridgeInventory.reduce((sum, f) => sum + f.waxCount, 0);
	const totalReagent = fridgeInventory.reduce((sum, f) => sum + f.reagentCount, 0);

	return {
		fridgeInventory,
		summary: {
			totalFridges: fridges.length,
			totalCartridges: totalWax + totalReagent,
			totalWax,
			totalReagent
		}
	};
};

export const config = { maxDuration: 60 };
