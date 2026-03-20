export const config = { maxDuration: 60 };
import { requirePermission } from '$lib/server/permissions';
import { connectDB, Consumable, EquipmentLocation, Equipment, WaxFillingRun, ReagentBatchRecord } from '$lib/server/db';
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

	// Locations
	const locations = (locationDocs as any[]).map(l => ({
		id: l._id,
		barcode: l.barcode ?? '',
		locationType: l.locationType ?? 'fridge',
		displayName: l.displayName ?? '',
		isActive: l.isActive ?? true,
		capacity: l.capacity ?? null
	}));

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
