import { redirect } from '@sveltejs/kit';
import { connectDB, CartridgeRecord, EquipmentLocation } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	await connectDB();

	// Get all fridges
	const fridgesRaw = await EquipmentLocation.find({ locationType: 'fridge' }).sort({ displayName: 1 }).lean().catch(() => []);
	const fridges = (fridgesRaw as any[]).map((f) => ({
		id: String(f._id),
		displayName: f.displayName ?? f.name ?? String(f._id),
		barcode: f.barcode ?? '',
		isActive: f.isActive ?? true
	}));

	// Get all stored cartridges (wax storage + reagent storage)
	// Wax-filled: have waxStorage.location set
	// Reagent-filled: have storage.fridgeName set
	const storedCartridges = await CartridgeRecord.find({
		$or: [
			{ 'waxStorage.location': { $exists: true, $ne: null } },
			{ 'storage.fridgeName': { $exists: true, $ne: null } }
		]
	}).select({
		_id: 1,
		currentPhase: 1,
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

	// Group cartridges by fridge
	const fridgeMap = new Map<string, any[]>();
	// Initialize with known fridges
	for (const f of fridges) {
		fridgeMap.set(f.barcode || f.displayName, []);
	}

	// Also track an "Unassigned" bucket for unknown locations
	for (const c of storedCartridges as any[]) {
		const waxLoc = c.waxStorage?.location;
		const reagentLoc = c.storage?.fridgeName;

		if (waxLoc) {
			const list = fridgeMap.get(waxLoc) ?? [];
			list.push({
				id: String(c._id),
				type: 'wax_filled',
				phase: c.currentPhase ?? 'wax_stored',
				location: waxLoc,
				storedAt: c.waxStorage?.recordedAt ? new Date(c.waxStorage.recordedAt).toISOString() : null,
				operator: c.waxStorage?.operator?.username ?? null,
				runId: c.waxFilling?.runId ?? null,
				assayType: null
			});
			fridgeMap.set(waxLoc, list);
		}

		if (reagentLoc) {
			const list = fridgeMap.get(reagentLoc) ?? [];
			list.push({
				id: String(c._id),
				type: 'reagent_filled',
				phase: c.currentPhase ?? 'stored',
				location: reagentLoc,
				storedAt: c.storage?.recordedAt ? new Date(c.storage.recordedAt).toISOString() : null,
				operator: c.storage?.operator?.username ?? null,
				runId: c.reagentFilling?.runId ?? null,
				assayType: c.reagentFilling?.assayType?.name ?? null
			});
			fridgeMap.set(reagentLoc, list);
		}
	}

	const fridgeInventory = Array.from(fridgeMap.entries()).map(([location, cartridges]) => {
		const fridge = fridges.find((f) => f.barcode === location || f.displayName === location);
		return {
			location,
			fridgeId: fridge?.id ?? null,
			displayName: fridge?.displayName ?? location,
			isActive: fridge?.isActive ?? true,
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
