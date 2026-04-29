import { redirect } from '@sveltejs/kit';
import { connectDB, CartridgeRecord, Equipment, EquipmentLocation } from '$lib/server/db';
import { getCheckedOutCartridgeIds } from '$lib/server/checkout-utils';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	await connectDB();

	// Manual checkouts represent physical removal from the fridge; they must
	// be excluded from active-occupancy queries even though the cartridge's
	// status field is intentionally preserved (scrapped/accepted markers
	// stay intact).
	const checkedOut = await getCheckedOutCartridgeIds();

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

	// Fetch cartridges physically present in a fridge.
	//  Three buckets serve two different operational purposes:
	//    (1) wax_accepted  — status='wax_stored' + waxQc.status='Accepted'
	//        (live inventory available for reagent fill)
	//    (2) wax_scrapped  — status='scrapped' + waxStorage.location set + not
	//        checked out; physically still occupying the fridge, QA quarantine
	//    (3) reagent       — status∈{stored, reagent_filled} with storage.fridgeName set
	const storedCartridges = await CartridgeRecord.find({
		_id: { $nin: checkedOut },
		$or: [
			{ 'waxStorage.location': { $exists: true, $ne: null }, status: 'wax_stored' },
			{ 'waxStorage.location': { $exists: true, $ne: null }, status: 'scrapped' },
			{ 'storage.fridgeName': { $exists: true, $ne: null }, status: { $in: ['stored', 'reagent_filled'] } }
		]
	}).select({
		_id: 1,
		status: 1,
		'waxQc.status': 1,
		'waxStorage.location': 1,
		'waxStorage.recordedAt': 1,
		'waxStorage.operator': 1,
		'waxFilling.runId': 1,
		voidReason: 1,
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
			// wax_stored -> accepted bucket; scrapped -> quarantine bucket.
			// A wax_stored cartridge without waxQc.status='Accepted' is an
			// anomaly (shouldn't happen on the storage path) but we bucket it
			// as "accepted" for display since the status is wax_stored.
			const type = c.status === 'scrapped' ? 'wax_scrapped' : 'wax_accepted';
			fridgeCartridges[idx].push({
				id: String(c._id),
				type,
				phase: c.status ?? 'wax_stored',
				qc: c.waxQc?.status ?? null,
				voidReason: c.voidReason ?? null,
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
				qc: null,
				voidReason: null,
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
		const waxAcceptedCount = cartridges.filter((c: any) => c.type === 'wax_accepted').length;
		const waxScrappedCount = cartridges.filter((c: any) => c.type === 'wax_scrapped').length;
		const reagentCount = cartridges.filter((c: any) => c.type === 'reagent_filled').length;
		return {
			location: fridge.barcode || fridge.displayName,
			fridgeId: fridge.id,
			displayName: fridge.displayName,
			isActive: fridge.isActive,
			cartridges,
			waxAcceptedCount,
			waxScrappedCount,
			reagentCount,
			totalCount: cartridges.length
		};
	}).sort((a, b) => a.displayName.localeCompare(b.displayName));

	const totalWaxAccepted = fridgeInventory.reduce((sum, f) => sum + f.waxAcceptedCount, 0);
	const totalWaxScrapped = fridgeInventory.reduce((sum, f) => sum + f.waxScrappedCount, 0);
	const totalReagent = fridgeInventory.reduce((sum, f) => sum + f.reagentCount, 0);

	return {
		fridgeInventory,
		summary: {
			totalFridges: fridges.length,
			totalCartridges: totalWaxAccepted + totalWaxScrapped + totalReagent,
			totalWaxAccepted,
			totalWaxScrapped,
			totalReagent
		}
	};
};

export const config = { maxDuration: 60 };
