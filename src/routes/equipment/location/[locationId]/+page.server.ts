export const config = { maxDuration: 60 };
import { error } from '@sveltejs/kit';
import { connectDB, EquipmentLocation, CartridgeRecord, WaxFillingRun } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals }) => {
	await connectDB();

	const { locationId } = params;

	// Load the location
	const locRaw = await EquipmentLocation.findById(locationId).lean().catch(() => null);
	if (!locRaw) {
		throw error(404, 'Location not found');
	}
	const loc = locRaw as any;

	const locationName = loc.displayName ?? loc.barcode ?? String(loc._id);
	const locationBarcode = loc.barcode ?? null;

	// Match cartridges by BOTH waxStorage.location and storage.fridgeName against barcode AND displayName
	const matchValues = [locationBarcode, locationName].filter(Boolean);

	const [cartridgesRaw, waxRunsRaw] = await Promise.all([
		CartridgeRecord.find({
			$or: [
				{ 'waxStorage.location': { $in: matchValues } },
				{ 'storage.fridgeName': { $in: matchValues } }
			]
		}).select({
			_id: 1,
			currentPhase: 1,
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
			$or: [
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

	const cartridges = (cartridgesRaw as any[]).map((c) => {
		const isWax = matchValues.includes(c.waxStorage?.location);
		const isReagent = matchValues.includes(c.storage?.fridgeName);
		const storedAt = isWax
			? (c.waxStorage?.recordedAt ?? null)
			: (c.storage?.recordedAt ?? null);
		const operator = isWax
			? (c.waxStorage?.operator?.username ?? null)
			: (c.storage?.operator?.username ?? null);

		return {
			id: String(c._id),
			currentPhase: c.currentPhase ?? null,
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

	return {
		location: {
			id: String(loc._id),
			name: locationName,
			barcode: locationBarcode,
			locationType: loc.locationType ?? 'fridge',
			capacity: loc.capacity ?? null,
			isActive: loc.isActive ?? true,
			createdAt: loc.createdAt?.toISOString?.() ?? null
		},
		cartridges,
		waxRuns,
		stats: {
			total: cartridges.length,
			waxCount,
			reagentCount,
			utilization: loc.capacity ? Math.round((cartridges.length / loc.capacity) * 100) : null
		}
	};
};
