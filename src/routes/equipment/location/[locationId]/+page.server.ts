export const config = { maxDuration: 60 };
import { error } from '@sveltejs/kit';
import { connectDB, Equipment, EquipmentLocation, CartridgeRecord, WaxFillingRun, BackingLot } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	await connectDB();

	const { locationId } = params;

	// Try Equipment first (parent fridge/oven), then fall back to EquipmentLocation (shelf)
	const equipRaw = await Equipment.findById(locationId).lean().catch(() => null) as any;
	const isEquipment = !!equipRaw;

	let locationName: string;
	let locationBarcode: string | null;
	let locationType: string;
	let capacity: number | null;
	let isActive: boolean;
	let createdAt: string | null;
	let childLocationIds: string[] = [];

	if (isEquipment) {
		locationName = equipRaw.name ?? String(equipRaw._id);
		locationBarcode = equipRaw.barcode ?? null;
		locationType = equipRaw.equipmentType ?? 'fridge';
		capacity = equipRaw.capacity ?? null;
		isActive = equipRaw.status !== 'offline';
		createdAt = equipRaw.createdAt?.toISOString?.() ?? null;

		// Load child locations (shelves) belonging to this equipment
		const children = await EquipmentLocation.find({ parentEquipmentId: locationId }).lean() as any[];
		childLocationIds = children.map((c: any) => String(c._id));

		// Aggregate capacity from children if equipment doesn't have its own
		if (!capacity && children.length > 0) {
			let total = 0;
			let hasAny = false;
			for (const child of children) {
				if (child.capacity) { total += child.capacity; hasAny = true; }
			}
			if (hasAny) capacity = total;
		}
	} else {
		const locRaw = await EquipmentLocation.findById(locationId).lean().catch(() => null);
		if (!locRaw) {
			throw error(404, 'Location not found');
		}
		const loc = locRaw as any;
		locationName = loc.displayName ?? loc.barcode ?? String(loc._id);
		locationBarcode = loc.barcode ?? null;
		locationType = loc.locationType ?? 'fridge';
		capacity = loc.capacity ?? null;
		isActive = loc.isActive ?? true;
		createdAt = loc.createdAt?.toISOString?.() ?? null;
	}

	// Build match values: equipment name/barcode + all child location barcodes/displayNames
	const matchValues = [locationBarcode, locationName].filter(Boolean) as string[];
	if (isEquipment) {
		const children = await EquipmentLocation.find({ parentEquipmentId: locationId }).lean() as any[];
		for (const child of children) {
			if (child.barcode) matchValues.push(child.barcode);
			if (child.displayName) matchValues.push(child.displayName);
		}
	}
	const uniqueMatchValues = [...new Set(matchValues)];

	// Only count cartridges that are still active inventory. Once a cartridge
	// ships/completes/voids/scraps, its waxStorage.location / storage.fridgeName
	// is a stale historical reference — it's no longer physically in the fridge.
	// Matches /equipment/activity + /cartridge-dashboard filters.
	const ACTIVE_WAX = ['wax_stored'];
	const ACTIVE_REAGENT = ['stored', 'reagent_filled', 'released', 'linked', 'inspected', 'sealed', 'cured'];
	const [cartridgesRaw, waxRunsRaw] = await Promise.all([
		CartridgeRecord.find({
			$or: [
				{ 'waxStorage.location': { $in: uniqueMatchValues }, status: { $in: ACTIVE_WAX } },
				{ 'storage.fridgeName': { $in: uniqueMatchValues }, status: { $in: ACTIVE_REAGENT } }
			]
		}).select({
			_id: 1,
			status: 1,
			'backing.lotId': 1,
			'waxFilling.robotName': 1,
			'waxFilling.deckId': 1,
			'waxFilling.runStartTime': 1,
			'waxFilling.runEndTime': 1,
			'waxQc.status': 1,
			'reagentFilling.assayType': 1,
			'topSeal.timestamp': 1,
			'waxStorage.location': 1,
			'waxStorage.recordedAt': 1,
			'waxStorage.operator': 1,
			'storage.fridgeName': 1,
			'storage.recordedAt': 1,
			'storage.operator': 1,
			updatedAt: 1
		}).lean().catch(() => []),

		WaxFillingRun.find({
			$or: isEquipment
				? [
					{ coolingLocationId: { $in: [locationId, ...childLocationIds] } },
					{ ovenLocationId: { $in: [locationId, ...childLocationIds] } }
				]
				: [
					{ coolingLocationId: locationId },
					{ ovenLocationId: locationId }
				]
		}).sort({ createdAt: -1 }).limit(20).select({
			_id: 1,
			status: 1,
			operator: 1,
			runStartTime: 1,
			runEndTime: 1,
			createdAt: 1,
			cartridgeIds: 1,
			plannedCartridgeCount: 1
		}).lean().catch(() => [])
	]);

	const matchSet = new Set(uniqueMatchValues);
	const cartridges = (cartridgesRaw as any[]).map((c) => {
		const isWax = matchSet.has(c.waxStorage?.location);
		const isReagent = matchSet.has(c.storage?.fridgeName);
		const storedAt = isWax
			? (c.waxStorage?.recordedAt ?? null)
			: (c.storage?.recordedAt ?? null);
		const operator = isWax
			? (c.waxStorage?.operator?.username ?? null)
			: (c.storage?.operator?.username ?? null);

		return {
			id: String(c._id),
			currentPhase: c.status ?? null,
			lotId: c.backing?.lotId ?? null,
			robotName: c.waxFilling?.robotName ?? null,
			deckId: c.waxFilling?.deckId ?? null,
			waxRunStart: c.waxFilling?.runStartTime?.toISOString?.() ?? null,
			waxRunEnd: c.waxFilling?.runEndTime?.toISOString?.() ?? null,
			waxQcStatus: c.waxQc?.status ?? null,
			assayType: c.reagentFilling?.assayType?.name ?? null,
			topSealAt: c.topSeal?.timestamp?.toISOString?.() ?? null,
			storedAt: storedAt ? new Date(storedAt).toISOString() : null,
			operator,
			storageType: isWax ? 'wax' : isReagent ? 'reagent' : 'unknown'
		};
	});

	// Ovens hold aggregate BackingLot buckets, not individual cartridges.
	// Cartridges don't exist as individual records during the backing phase;
	// the bucket's cartridgeCount is the physical count. Surface one row per
	// bucket in the inventory table so operators can see what's in the oven.
	const backingLotsInOven: { lotId: string; cartridgeCount: number; enteredAt: string | null; status: string }[] = [];
	if (isEquipment && locationType === 'oven') {
		const lots = await BackingLot.find({
			ovenLocationId: locationId,
			status: { $in: ['in_oven', 'ready'] }
		}).lean().catch(() => [] as any[]);
		for (const bl of lots as any[]) {
			backingLotsInOven.push({
				lotId: String(bl._id),
				cartridgeCount: bl.cartridgeCount ?? 0,
				enteredAt: bl.ovenEntryTime ? new Date(bl.ovenEntryTime).toISOString() : null,
				status: bl.status
			});
		}
	}

	const waxRuns = (waxRunsRaw as any[]).map((r) => ({
		id: String(r._id),
		status: r.status ?? null,
		operatorName: r.operator?.username ?? null,
		runStartTime: r.runStartTime?.toISOString?.() ?? null,
		runEndTime: r.runEndTime?.toISOString?.() ?? null,
		createdAt: r.createdAt?.toISOString?.() ?? null,
		cartridgeCount: r.cartridgeIds?.length ?? r.plannedCartridgeCount ?? 0
	}));

	const waxCount = cartridges.filter((c) => c.storageType === 'wax').length;
	const reagentCount = cartridges.filter((c) => c.storageType === 'reagent').length;
	const backingCount = backingLotsInOven.reduce((s, b) => s + b.cartridgeCount, 0);

	return {
		location: {
			id: locationId,
			name: locationName,
			barcode: locationBarcode,
			locationType,
			capacity,
			isActive,
			createdAt
		},
		cartridges,
		waxRuns,
		backingLots: backingLotsInOven,
		stats: {
			total: cartridges.length + backingCount,
			waxCount,
			reagentCount,
			backingCount,
			utilization: capacity ? Math.round(((cartridges.length + backingCount) / capacity) * 100) : null
		}
	};
};
