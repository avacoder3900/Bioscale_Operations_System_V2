export const config = { maxDuration: 60 };
import { requirePermission } from '$lib/server/permissions';
import { connectDB, Consumable, EquipmentLocation, Equipment, WaxFillingRun, ReagentBatchRecord, CartridgeRecord } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'equipment:read');
	await connectDB();

	const [
		deckDocs, trayDocs, locationDocs, equipmentDocs,
		activeWaxDocs, activeReagentDocs,
		waxHistoryDocs, reagentHistoryDocs
	] = await Promise.all([
		Consumable.find({ type: 'deck' }).lean(),
		Consumable.find({ type: 'cooling_tray' }).lean(),
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

	// Compute occupant counts from CartridgeRecord
	const [waxCounts, reagentCounts] = await Promise.all([
		CartridgeRecord.aggregate([
			{ $match: { 'waxStorage.location': { $exists: true }, currentPhase: 'wax_stored' } },
			{ $group: { _id: '$waxStorage.location', count: { $sum: 1 } } }
		]).catch(() => []),
		CartridgeRecord.aggregate([
			{ $match: { 'storage.fridgeName': { $exists: true }, currentPhase: { $in: ['stored', 'reagent_filled'] } } },
			{ $group: { _id: '$storage.fridgeName', count: { $sum: 1 } } }
		]).catch(() => [])
	]);
	const occupantMap = new Map<string, number>();
	for (const c of [...waxCounts as any[], ...reagentCounts as any[]]) {
		// Match by barcode or display name
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
	for (const equip of equipmentDocs as any[]) {
		if (equip.equipmentType !== 'fridge' && equip.equipmentType !== 'oven') continue;
		const children = childLocMap.get(String(equip._id)) ?? [];
		let occupants = 0;
		const keys = [equip.barcode, equip.name].filter(Boolean);
		for (const key of keys) occupants += occupantMap.get(key) ?? 0;
		for (const child of children) {
			const childKeys = [child.barcode, child.displayName].filter(Boolean);
			for (const key of childKeys) occupants += occupantMap.get(key) ?? 0;
		}
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
			occupantCount: occupants
		});
	}
	for (const l of orphanLocs) {
		const barcode = l.barcode ?? '';
		const name = l.displayName ?? '';
		const occupants = (occupantMap.get(barcode) ?? 0) + (occupantMap.get(name) ?? 0);
		locations.push({
			id: l._id,
			barcode,
			locationType: l.locationType ?? 'fridge',
			displayName: name,
			isActive: l.isActive ?? true,
			capacity: l.capacity ?? null,
			occupantCount: occupants
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

	return {
		decks,
		trays,
		locations,
		equipmentTemps,
		placements,
		activeWaxRuns,
		activeReagentRuns,
		waxRunHistory,
		reagentRunHistory
	};
};
