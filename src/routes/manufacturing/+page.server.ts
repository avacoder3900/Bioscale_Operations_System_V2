import { redirect } from '@sveltejs/kit';
import {
	connectDB, WaxFillingRun, ReagentBatchRecord, CartridgeRecord,
	BackingLot, LaserCutBatch, Consumable, LotRecord, ManufacturingSettings,
	OpentronsRobot, ManufacturingMaterial, ShippingLot, BarcodeInventory,
	Equipment, EquipmentLocation
} from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad } from './$types';

export const config = { maxDuration: 60 };

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();

	const now = Date.now();
	const todayStart = new Date();
	todayStart.setHours(0, 0, 0, 0);

	const weekStart = new Date(todayStart);
	weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));

	const [
		robots, settingsDoc, activeWaxRuns, activeReagentRuns,
		backingLots, phaseCounts, equipOvens, locationOvens, recentLots
	] = await Promise.all([
		OpentronsRobot.find({}).select('_id name').lean(),
		ManufacturingSettings.findById('default').lean(),
		WaxFillingRun.find({
			status: { $nin: ['completed', 'aborted', 'cancelled', 'voided',
				'Completed', 'Aborted', 'Cancelled', 'Voided'] }
		}).lean(),
		ReagentBatchRecord.find({
			status: { $nin: ['completed', 'aborted', 'cancelled', 'voided',
				'Completed', 'Aborted', 'Cancelled'] }
		}).lean(),
		BackingLot.find({ status: { $in: ['in_oven', 'ready', 'created'] } })
			.sort({ ovenEntryTime: -1 }).lean(),
		CartridgeRecord.aggregate([{ $group: { _id: '$currentPhase', count: { $sum: 1 } } }]),
		Equipment.find({ equipmentType: 'oven', status: { $ne: 'offline' } }).sort({ name: 1 }).lean(),
		EquipmentLocation.find({ locationType: 'oven', isActive: true, parentEquipmentId: { $exists: false } }).lean(),
		LotRecord.find().sort({ createdAt: -1 }).limit(10).lean()
	]);

	const settings = settingsDoc as any ?? {};
	const minOvenTimeMin: number = settings?.waxFilling?.minOvenTimeMin ?? 60;
	const robotStallWarningMin: number = settings?.general?.robotStallWarningMin ?? 90;
	const refreshIntervalSec: number = settings?.general?.dashboardRefreshIntervalSec ?? 30;

	const phaseMap = new Map<string, number>(
		phaseCounts.map((p: any) => [p._id ?? 'unknown', p.count])
	);

	const [
		waxRunsToday, reagentRunsToday, rejectedToday, producedToday,
		waxRunsWeek, reagentRunsWeek, rejectedWeek, producedWeek,
		robotUtilWax, robotUtilReagent
	] = await Promise.all([
		WaxFillingRun.aggregate([
			{ $match: { createdAt: { $gte: todayStart } } },
			{ $group: { _id: '$status', count: { $sum: 1 } } }
		]),
		ReagentBatchRecord.aggregate([
			{ $match: { createdAt: { $gte: todayStart } } },
			{ $group: { _id: '$status', count: { $sum: 1 } } }
		]),
		CartridgeRecord.countDocuments({ currentPhase: 'voided', updatedAt: { $gte: todayStart } }),
		CartridgeRecord.countDocuments({
			'reagentFilling.recordedAt': { $gte: todayStart },
			currentPhase: { $in: ['reagent_filled', 'sealed', 'stored'] }
		}),
		WaxFillingRun.aggregate([
			{ $match: { createdAt: { $gte: weekStart } } },
			{ $group: { _id: '$status', count: { $sum: 1 } } }
		]),
		ReagentBatchRecord.aggregate([
			{ $match: { createdAt: { $gte: weekStart } } },
			{ $group: { _id: '$status', count: { $sum: 1 } } }
		]),
		CartridgeRecord.countDocuments({ currentPhase: 'voided', updatedAt: { $gte: weekStart } }),
		CartridgeRecord.countDocuments({
			'reagentFilling.recordedAt': { $gte: weekStart },
			currentPhase: { $in: ['reagent_filled', 'sealed', 'stored'] }
		}),
		WaxFillingRun.aggregate([
			{ $match: { createdAt: { $gte: todayStart }, runStartTime: { $exists: true } } },
			{ $project: {
				robotId: '$robot._id',
				durationMs: { $subtract: [{ $ifNull: ['$runEndTime', new Date()] }, '$runStartTime'] }
			} },
			{ $group: { _id: '$robotId', totalMs: { $sum: '$durationMs' } } }
		]),
		ReagentBatchRecord.aggregate([
			{ $match: { createdAt: { $gte: todayStart }, runStartTime: { $exists: true } } },
			{ $project: {
				robotId: '$robot._id',
				durationMs: { $subtract: [{ $ifNull: ['$runEndTime', new Date()] }, '$runStartTime'] }
			} },
			{ $group: { _id: '$robotId', totalMs: { $sum: '$durationMs' } } }
		])
	]);

	const enrichedBackingLots = (backingLots as any[]).map((bl: any) => {
		const entryMs = bl.ovenEntryTime ? new Date(bl.ovenEntryTime).getTime() : 0;
		const elapsedMin = entryMs ? (now - entryMs) / 60000 : 0;
		return {
			lotId: String(bl._id),
			cartridgeCount: bl.cartridgeCount ?? 0,
			status: bl.status ?? 'in_oven',
			ovenLocationId: bl.ovenLocationId ?? null,
			ovenLocationName: bl.ovenLocationName ?? null,
			ovenEntryTime: bl.ovenEntryTime ? new Date(bl.ovenEntryTime).toISOString() : null,
			elapsedMin: Math.floor(elapsedMin),
			remainingMin: Math.max(0, Math.ceil(minOvenTimeMin - elapsedMin)),
			isReady: elapsedMin >= minOvenTimeMin,
			operatorUsername: bl.operator?.username ?? null
		};
	});

	// Build ovens-with-contents: one row per oven Equipment/Location with its BackingLots inside
	const ovenSources = [
		...(equipOvens as any[]).map((e: any) => ({
			id: String(e._id),
			displayName: e.name ?? e.barcode ?? String(e._id),
			barcode: e.barcode ?? ''
		})),
		...(locationOvens as any[]).map((o: any) => ({
			id: String(o._id),
			displayName: o.displayName ?? o.barcode ?? String(o._id),
			barcode: o.barcode ?? ''
		}))
	];

	const ovensWithContents = ovenSources.map((oven) => {
		const lotsInOven = enrichedBackingLots.filter((bl) => bl.ovenLocationId === oven.id);
		const totalCartridges = lotsInOven.reduce((s, bl) => s + bl.cartridgeCount, 0);
		const readyLotCount = lotsInOven.filter((l) => l.isReady).length;
		return {
			...oven,
			lots: lotsInOven,
			lotCount: lotsInOven.length,
			totalCartridges,
			readyLotCount
		};
	});

	const WAX_ACTIVE = ['Setup', 'Loading', 'Running', 'setup', 'loading', 'running'];
	const WAX_DECK_FREE = ['Awaiting Removal', 'QC', 'Storage', 'awaiting_removal', 'qc', 'storage'];
	const REAGENT_ACTIVE = ['Setup', 'Loading', 'Running', 'setup', 'loading', 'running'];
	const REAGENT_DECK_FREE = ['Inspection', 'Top Sealing', 'Storage'];

	const robotUtilMap = new Map<string, number>();
	for (const r of [...(robotUtilWax as any[]), ...(robotUtilReagent as any[])]) {
		robotUtilMap.set(r._id, (robotUtilMap.get(r._id) ?? 0) + (r.totalMs ?? 0));
	}

	const robotStatuses = (robots as any[]).map((robot: any) => {
		const robotId = String(robot._id);
		const waxRun = (activeWaxRuns as any[]).find((r) => String(r.robot?._id) === robotId);
		const reagentRun = (activeReagentRuns as any[]).find((r) => String(r.robot?._id) === robotId);

		let status: string;
		let displayStatus: string;
		let robotPhysicallyFree: boolean;
		if (waxRun && WAX_ACTIVE.includes(waxRun.status)) {
			status = 'running_wax';
			displayStatus = `Running — Wax Fill (${waxRun.status})`;
			robotPhysicallyFree = false;
		} else if (reagentRun && REAGENT_ACTIVE.includes(reagentRun.status)) {
			status = 'running_reagent';
			displayStatus = `Running — Reagent Fill (${reagentRun.status})`;
			robotPhysicallyFree = false;
		} else if (waxRun && WAX_DECK_FREE.includes(waxRun.status)) {
			status = 'deck_free_wax';
			displayStatus = `Robot Free — Wax run: ${waxRun.status}`;
			robotPhysicallyFree = true;
		} else if (reagentRun && REAGENT_DECK_FREE.includes(reagentRun.status)) {
			status = 'deck_free_reagent';
			displayStatus = `Robot Free — Reagent run: ${reagentRun.status}`;
			robotPhysicallyFree = true;
		} else {
			status = 'available';
			displayStatus = 'Available';
			robotPhysicallyFree = true;
		}

		const activeRun = waxRun ?? reagentRun;
		const runStartTime = activeRun?.runStartTime;
		const elapsedMs = runStartTime ? now - new Date(runStartTime).getTime() : 0;
		const lastUpdatedAt = activeRun?.updatedAt ? new Date(activeRun.updatedAt).getTime() : 0;
		const minutesSinceUpdate = lastUpdatedAt ? (now - lastUpdatedAt) / 60000 : 0;

		const utilizationMs = robotUtilMap.get(robotId) ?? 0;
		const shiftHours = 8;
		const utilizationPct = Math.min(100, Math.round((utilizationMs / (shiftHours * 3600000)) * 100));

		return {
			robotId,
			name: robot.name ?? robotId,
			status,
			displayStatus,
			utilizationPct,
			utilizationHours: Math.round((utilizationMs / 3600000) * 10) / 10,
			isStalled: !robotPhysicallyFree && minutesSinceUpdate > robotStallWarningMin,
			minutesSinceUpdate: Math.floor(minutesSinceUpdate),
			activeWaxRun: waxRun ? {
				runId: String(waxRun._id),
				stage: waxRun.status,
				operatorUsername: waxRun.operator?.username ?? null,
				cartridgeCount: waxRun.cartridgeIds?.length ?? waxRun.plannedCartridgeCount ?? 0,
				elapsedMin: Math.floor(elapsedMs / 60000),
				waxSourceLot: waxRun.waxSourceLot ?? null
			} : null,
			activeReagentRun: reagentRun ? {
				runId: String(reagentRun._id),
				stage: reagentRun.status,
				operatorUsername: reagentRun.operator?.username ?? null,
				assayTypeName: reagentRun.assayType?.name ?? null,
				cartridgeCount: reagentRun.cartridgeCount ?? reagentRun.cartridgesFilled?.length ?? 0,
				elapsedMin: Math.floor(elapsedMs / 60000)
			} : null
		};
	});

	const alerts: { level: string; message: string }[] = [];
	for (const r of robotStatuses) {
		if (r.isStalled) {
			alerts.push({ level: 'red', message: `${r.name} run may be stalled — last update ${r.minutesSinceUpdate} min ago` });
		}
	}

	const sumByStatus = (agg: any[], statuses: string[]) =>
		agg.filter((a) => statuses.includes(a._id)).reduce((s, a) => s + a.count, 0);
	const completedStatuses = ['completed', 'Completed'];
	const activeStatuses = ['Setup', 'Loading', 'Running', 'setup', 'loading', 'running',
		'Awaiting Removal', 'QC', 'Storage', 'Inspection', 'Top Sealing'];
	const abortedStatuses = ['aborted', 'Aborted', 'cancelled', 'Cancelled'];

	const yieldPercent = producedToday > 0
		? Math.round(((producedToday - rejectedToday) / producedToday) * 1000) / 10
		: 0;
	const weeklyYieldPercent = producedWeek > 0
		? Math.round(((producedWeek - rejectedWeek) / producedWeek) * 1000) / 10
		: 0;

	return JSON.parse(JSON.stringify({
		robots: robotStatuses,
		ovens: ovensWithContents,
		pipeline: {
			backing: {
				inProgressLots: enrichedBackingLots.filter((bl) => !bl.isReady),
				readyLots: enrichedBackingLots.filter((bl) => bl.isReady),
				totalReadyCartridges: enrichedBackingLots.filter((bl) => bl.isReady).reduce((s, bl) => s + bl.cartridgeCount, 0),
				backedTotal: phaseMap.get('backing') ?? 0
			},
			waxFilling: {
				inProgress: phaseMap.get('wax_filling') ?? 0,
				waxFilled: phaseMap.get('wax_filled') ?? 0,
				waxStored: phaseMap.get('wax_stored') ?? 0
			},
			reagentFilling: {
				inProgress: phaseMap.get('reagent_filling') ?? 0,
				reagentFilled: phaseMap.get('reagent_filled') ?? 0,
				sealed: phaseMap.get('sealed') ?? 0
			},
			storage: {
				stored: phaseMap.get('stored') ?? 0,
				voided: phaseMap.get('voided') ?? 0
			}
		},
		todayStats: {
			waxRuns: {
				completed: sumByStatus(waxRunsToday, completedStatuses),
				inProgress: sumByStatus(waxRunsToday, activeStatuses),
				aborted: sumByStatus(waxRunsToday, abortedStatuses)
			},
			reagentRuns: {
				completed: sumByStatus(reagentRunsToday, completedStatuses),
				inProgress: sumByStatus(reagentRunsToday, activeStatuses),
				aborted: sumByStatus(reagentRunsToday, abortedStatuses)
			},
			producedToday,
			rejectedToday,
			acceptedToday: producedToday - rejectedToday,
			yieldPercent
		},
		weeklyStats: {
			waxRuns: (waxRunsWeek as any[]).reduce((s: number, a: any) => s + a.count, 0),
			reagentRuns: (reagentRunsWeek as any[]).reduce((s: number, a: any) => s + a.count, 0),
			produced: producedWeek,
			rejected: rejectedWeek,
			yieldPercent: weeklyYieldPercent
		},
		recentLots: (recentLots as any[]).map((l: any) => ({
			lotId: l._id,
			configId: l.processConfig?._id ?? '',
			quantityProduced: l.quantityProduced ?? 0,
			finishTime: l.finishTime ?? null,
			cycleTime: l.cycleTime ?? null,
			status: l.status ?? 'unknown',
			username: l.operator?.username ?? null
		})),
		alerts,
		minOvenTimeMin,
		refreshIntervalSec
	}));
};
