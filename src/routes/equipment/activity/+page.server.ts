export const config = { maxDuration: 60 };
import { requirePermission } from '$lib/server/permissions';
import { connectDB, EquipmentLocation, Equipment, WaxFillingRun, ReagentBatchRecord, CartridgeRecord, BackingLot } from '$lib/server/db';
import { getCheckedOutCartridgeIds } from '$lib/server/checkout-utils';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'equipment:read');
	await connectDB();

	// Exclude manually checked-out cartridges from fridge occupancy counts
	const checkedOutIds = await getCheckedOutCartridgeIds();

	const [
		deckDocs, trayDocs, locationDocs, equipmentDocs,
		activeWaxDocs, activeReagentDocs,
		waxHistoryDocs, reagentHistoryDocs
	] = await Promise.all([
		Equipment.find({ equipmentType: 'deck' }).lean(),
		Equipment.find({ equipmentType: 'cooling_tray' }).lean(),
		EquipmentLocation.find({ isActive: true }).lean(),
		Equipment.find({ isActive: { $ne: false } }).lean(),
		WaxFillingRun.find({ status: { $in: ['setup', 'running'] } }).sort({ createdAt: -1 }).lean(),
		ReagentBatchRecord.find({ status: { $in: ['setup', 'running'] } }).sort({ createdAt: -1 }).lean(),
		WaxFillingRun.find().sort({ createdAt: -1 }).limit(50).lean(),
		ReagentBatchRecord.find().sort({ createdAt: -1 }).limit(50).lean()
	]);

	// Decks
	const decks = (deckDocs as any[]).map(d => ({
		deckId: d._id,
		status: d.status ?? 'unknown',
		currentRobotId: d.currentRobotId ?? null,
		lastUsed: d.lastUsed ?? null
	}));

	// Trays
	const trays = (trayDocs as any[]).map(t => ({
		trayId: t._id,
		status: t.status ?? 'unknown',
		assignedRunId: t.assignedRunId ?? null
	}));

	// Compute occupant counts from CartridgeRecord + BackingLot.
	//
	// Fridges have three buckets — same split used by /inventory/fridge-storage:
	//   (1) waxAccepted: status='wax_stored' (post-QC, live inventory)
	//   (2) waxScrapped: status='scrapped' with waxStorage.location set
	//       (physically still in the fridge as QA quarantine until checkout)
	//   (3) reagent: status∈{stored, reagent_filled} with storage.fridgeName
	//
	// Ovens: individual CartridgeRecord docs don't exist during the backing
	// phase — cartridges only become individuated when their UUID is scanned
	// at wax deck loading. So oven occupancy is an aggregate read from
	// BackingLot.cartridgeCount (decremented by wax-filling loadDeck).
	const [waxAcceptedCounts, waxScrappedCounts, reagentCounts, ovenCountsById] = await Promise.all([
		CartridgeRecord.aggregate([
			{ $match: { 'waxStorage.location': { $exists: true }, status: 'wax_stored', _id: { $nin: checkedOutIds } } },
			{ $group: { _id: '$waxStorage.location', count: { $sum: 1 } } }
		]).catch(() => []),
		CartridgeRecord.aggregate([
			{ $match: { 'waxStorage.location': { $exists: true }, status: 'scrapped', _id: { $nin: checkedOutIds } } },
			{ $group: { _id: '$waxStorage.location', count: { $sum: 1 } } }
		]).catch(() => []),
		CartridgeRecord.aggregate([
			{ $match: { 'storage.fridgeName': { $exists: true }, status: { $in: ['stored', 'reagent_filled'] }, _id: { $nin: checkedOutIds } } },
			{ $group: { _id: '$storage.fridgeName', count: { $sum: 1 } } }
		]).catch(() => []),
		BackingLot.aggregate([
			{ $match: { status: { $in: ['in_oven', 'ready'] }, ovenLocationId: { $exists: true, $ne: null } } },
			{ $group: { _id: '$ovenLocationId', count: { $sum: '$cartridgeCount' } } }
		]).catch(() => [])
	]);
	const waxAcceptedMap = new Map<string, number>();
	const waxScrappedMap = new Map<string, number>();
	const occupantMap = new Map<string, number>();
	for (const c of waxAcceptedCounts as any[]) {
		waxAcceptedMap.set(c._id, (waxAcceptedMap.get(c._id) ?? 0) + c.count);
		occupantMap.set(c._id, (occupantMap.get(c._id) ?? 0) + c.count);
	}
	for (const c of waxScrappedCounts as any[]) {
		waxScrappedMap.set(c._id, (waxScrappedMap.get(c._id) ?? 0) + c.count);
		occupantMap.set(c._id, (occupantMap.get(c._id) ?? 0) + c.count);
	}
	for (const c of [...(reagentCounts as any[]), ...(ovenCountsById as any[])]) {
		occupantMap.set(c._id, (occupantMap.get(c._id) ?? 0) + c.count);
	}

	// Build child map for parent grouping
	const childLocMap = new Map<string, any[]>();
	const orphanLocs: any[] = [];
	for (const l of locationDocs as any[]) {
		if (l.parentEquipmentId) {
			const children = childLocMap.get(l.parentEquipmentId) ?? [];
			children.push(l);
			childLocMap.set(l.parentEquipmentId, children);
		} else {
			orphanLocs.push(l);
		}
	}

	// Locations: show Equipment as parent entries, plus orphan EquipmentLocations
	const locations: any[] = [];
	const sumKeys = (map: Map<string, number>, keys: string[]) =>
		keys.reduce((acc, k) => acc + (map.get(k) ?? 0), 0);
	for (const equip of equipmentDocs as any[]) {
		if (!['fridge', 'oven', 'robot'].includes(equip.equipmentType)) continue;
		const children = childLocMap.get(String(equip._id)) ?? [];
		// Match keys: equipment _id (for ovenLocationId), barcode, and display name
		const ownKeys = [String(equip._id), equip.barcode, equip.name].filter(Boolean) as string[];
		const childKeys = children.flatMap((c: any) => [c.barcode, c.displayName].filter(Boolean) as string[]);
		const allKeys = [...ownKeys, ...childKeys];
		const occupants = sumKeys(occupantMap, allKeys);
		const waxAccepted = sumKeys(waxAcceptedMap, allKeys);
		const waxScrapped = sumKeys(waxScrappedMap, allKeys);
		let capacity = equip.capacity ?? null;
		if (!capacity && children.length > 0) {
			let total = 0; let hasAny = false;
			for (const child of children) { if (child.capacity) { total += child.capacity; hasAny = true; } }
			if (hasAny) capacity = total;
		}
		locations.push({
			id: equip._id,
			barcode: equip.barcode ?? '',
			locationType: equip.equipmentType ?? 'fridge',
			displayName: equip.name ?? '',
			isActive: equip.status !== 'offline',
			capacity,
			occupantCount: occupants,
			waxAcceptedCount: waxAccepted,
			waxScrappedCount: waxScrapped
		});
	}
	for (const l of orphanLocs) {
		const barcode = l.barcode ?? '';
		const name = l.displayName ?? '';
		const keys = [barcode, name].filter(Boolean) as string[];
		locations.push({
			id: l._id,
			barcode,
			locationType: l.locationType ?? 'fridge',
			displayName: name,
			isActive: l.isActive ?? true,
			capacity: l.capacity ?? null,
			occupantCount: sumKeys(occupantMap, keys),
			waxAcceptedCount: sumKeys(waxAcceptedMap, keys),
			waxScrappedCount: sumKeys(waxScrappedMap, keys)
		});
	}

	// Equipment temperatures keyed by name
	const equipmentTemps: Record<string, number | null> = {};
	for (const eq of equipmentDocs as any[]) {
		equipmentTemps[eq.name] = eq.currentTemperatureC ?? null;
	}

	// Placements from locations
	const placements: { locationId: string; locationType: string; displayName: string; itemType: string; itemId: string }[] = [];
	for (const loc of locationDocs as any[]) {
		for (const p of loc.currentPlacements ?? []) {
			placements.push({
				locationId: loc._id,
				locationType: loc.locationType ?? 'fridge',
				displayName: loc.displayName ?? '',
				itemType: p.itemType ?? '',
				itemId: p.itemId ?? ''
			});
		}
	}

	// Active wax runs
	const activeWaxRuns = (activeWaxDocs as any[]).map(r => ({
		runId: r._id,
		robotId: r.robot?._id ?? '',
		deckId: r.deckId ?? null,
		coolingTrayId: r.coolingTrayId ?? null,
		status: r.status ?? 'unknown'
	}));

	// Active reagent runs
	const activeReagentRuns = (activeReagentDocs as any[]).map(r => ({
		runId: r._id,
		robotId: r.robot?._id ?? '',
		deckId: r.deckId ?? null,
		status: r.status ?? 'unknown'
	}));

	// Wax run history
	const waxRunHistory = (waxHistoryDocs as any[]).map(r => ({
		runId: r._id,
		robotId: r.robot?._id ?? '',
		deckId: r.deckId ?? null,
		coolingTrayId: r.coolingTrayId ?? null,
		waxSourceLot: r.waxSourceLot ?? null,
		status: r.status ?? 'unknown',
		operatorName: r.operator?.username ?? '',
		abortReason: r.abortReason ?? null,
		plannedCartridgeCount: r.plannedCartridgeCount ?? null,
		runStartTime: r.runStartTime ?? null,
		runEndTime: r.runEndTime ?? null,
		createdAt: r.createdAt
	}));

	// Reagent run history
	const reagentRunHistory = (reagentHistoryDocs as any[]).map(r => ({
		runId: r._id,
		robotId: r.robot?._id ?? '',
		deckId: r.deckId ?? null,
		status: r.status ?? 'unknown',
		operatorName: r.operator?.username ?? '',
		abortReason: r.abortReason ?? null,
		cartridgeCount: r.cartridgeCount ?? null,
		runStartTime: r.runStartTime ?? null,
		runEndTime: r.runEndTime ?? null,
		createdAt: r.createdAt
	}));

	// Robots from equipment collection
	const robotDocs = (equipmentDocs as any[]).filter(e => e.equipmentType === 'robot');
	const robots = robotDocs.map((r: any) => ({
		robotId: String(r._id),
		name: r.name ?? String(r._id),
		status: r.status ?? 'active'
	}));

	return {
		decks,
		trays,
		locations,
		equipmentTemps,
		placements,
		activeWaxRuns,
		activeReagentRuns,
		waxRunHistory,
		reagentRunHistory,
		robots
	};
};
