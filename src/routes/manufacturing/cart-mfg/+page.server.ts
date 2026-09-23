import { redirect } from '@sveltejs/kit';

import {
	connectDB, WaxFillingRun, ReagentBatchRecord, CartridgeRecord,
	BackingLot, LaserCutBatch, Consumable, LotRecord, ManufacturingSettings,
	OpentronsRobot, ManufacturingMaterial, ShippingLot, BarcodeInventory

} from '$lib/server/db';
import { getCheckedOutCartridgeIds } from '$lib/server/checkout-utils';
import { requirePermission } from '$lib/server/permissions';
import { stageCounts } from '$lib/server/services/bucket-service';
import { WAX_STAGE_STATUSES } from '$lib/shared/cartridge-wax-status';
import type { PageServerLoad } from './$types';

export const config = { maxDuration: 60 };

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();

	// Manually checked-out cartridges drop out of every phase/QC count below
	// so the dashboard stays consistent with fridge/oven occupancy.
	const checkedOutIds = await getCheckedOutCartridgeIds();

	const now = Date.now();
	const todayStart = new Date();
	todayStart.setHours(0, 0, 0, 0);

	const weekStart = new Date(todayStart);
	weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));

	const [
		robots, settingsDoc, activeWaxRuns, activeReagentRuns,
		backingLots, backingCartGroups, phaseCounts, recentLots
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
		// LEGACY (WAX-FLOW-2): aggregate BackingLot buckets are display-only
		// until drained — nothing writes to BackingLot any more.
		BackingLot.find({
			status: { $in: ['in_oven', 'ready', 'created'] },
			cartridgeCount: { $gt: 0 }
		}).sort({ createdAt: -1 }).lean(),
		// Cartridges at 'backing' ("In Oven"), one row per WI-01 batch. No oven
		// grouping — backing-oven tracking was removed app-wide (2026-09-23).
		CartridgeRecord.aggregate([
			{ $match: { status: 'backing', _id: { $nin: checkedOutIds } } },
			{ $group: {
				_id: { lotId: '$backing.parentLotRecordId' },
				count: { $sum: 1 },
				newest: { $max: '$backing.recordedAt' },
				operatorUsername: { $last: '$backing.operator.username' }
			} },
			{ $sort: { newest: -1 } }
		]),
		CartridgeRecord.aggregate([
			{ $match: { _id: { $nin: checkedOutIds } } },
			{ $group: { _id: '$status', count: { $sum: 1 } } }
		]),
		LotRecord.find().sort({ createdAt: -1 }).limit(10).lean()
	]);

	const settings = settingsDoc as any ?? {};

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
		CartridgeRecord.countDocuments({ status: { $in: ['voided', 'scrapped'] }, updatedAt: { $gte: todayStart }, _id: { $nin: checkedOutIds } }),
		CartridgeRecord.countDocuments({
			'reagentFilling.recordedAt': { $gte: todayStart },
			status: { $in: ['reagent_filled', 'sealed', 'stored'] },
			_id: { $nin: checkedOutIds }
		}),
		WaxFillingRun.aggregate([
			{ $match: { createdAt: { $gte: weekStart } } },
			{ $group: { _id: '$status', count: { $sum: 1 } } }
		]),
		ReagentBatchRecord.aggregate([
			{ $match: { createdAt: { $gte: weekStart } } },
			{ $group: { _id: '$status', count: { $sum: 1 } } }
		]),
		CartridgeRecord.countDocuments({ status: { $in: ['voided', 'scrapped'] }, updatedAt: { $gte: weekStart }, _id: { $nin: checkedOutIds } }),
		CartridgeRecord.countDocuments({
			'reagentFilling.recordedAt': { $gte: weekStart },
			status: { $in: ['reagent_filled', 'sealed', 'stored'] },
			_id: { $nin: checkedOutIds }
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

	// Backing ("In Oven"): one row per WI-01 batch, built from individual
	// 'backing' CartridgeRecords. Backing-oven tracking and the cure-time gate
	// were removed app-wide (2026-09-23, BUCKET-SYSTEM_PLAN v2): no oven, no
	// readiness — every backed cartridge is ready for wax filling.
	const backingBatchRows = (backingCartGroups as any[]).map((g: any) => ({
		lotId: String(g._id?.lotId ?? 'unknown'),
		cartridgeCount: g.count ?? 0,
		status: 'in_oven',
		operatorUsername: g.operatorUsername ?? null,
		legacy: false
	}));
	// LEGACY rows: undrained BackingLot aggregates, display-only until drained.
	const legacyBackingRows = (backingLots as any[]).map((bl: any) => ({
		lotId: String(bl._id),
		cartridgeCount: bl.cartridgeCount ?? 0,
		status: bl.status ?? 'in_oven',
		operatorUsername: bl.operator?.username ?? null,
		legacy: true
	}));
	const enrichedBackingLots = [...backingBatchRows, ...legacyBackingRows];
	const legacyBackedTotal = legacyBackingRows.reduce((s, r) => s + r.cartridgeCount, 0);

	// Filling-page-owned stages — while a run is in these, the operator is
	// actively handling it on the wax-filling / reagent-filling page and the
	// robot is "In Use". Mirrors the classification on Opentron Control.
	const WAX_ACTIVE = ['Setup', 'Loading', 'Running', 'Awaiting Removal',
		'setup', 'loading', 'running', 'awaiting_removal', 'cooling'];
	const REAGENT_ACTIVE = ['Setup', 'Loading', 'Running', 'Inspection',
		'setup', 'loading', 'running', 'inspection'];
	// Post-OT-2 / on the Opentron Control queue — run still exists but robot
	// is free for a new filling run.
	const WAX_POST_OT2_QUEUED = ['QC', 'Storage', 'qc', 'storage'];
	// Reagent runs have no post-OT-2 queue (REAGENT-TOPSEAL-IMPLICIT): Running
	// is the terminal stage, so a reagent run is either active or done.

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
			displayStatus = `In Use — Wax (${waxRun.status})`;
			robotPhysicallyFree = false;
		} else if (reagentRun && REAGENT_ACTIVE.includes(reagentRun.status)) {
			status = 'running_reagent';
			displayStatus = `In Use — Reagent (${reagentRun.status})`;
			robotPhysicallyFree = false;
		} else if (waxRun && WAX_POST_OT2_QUEUED.includes(waxRun.status)) {
			// Robot is free for a new run; the wax run is queued on Opentron
			// Control for post-OT-2 handling.
			status = 'available';
			displayStatus = `Available — Wax queued (${waxRun.status})`;
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
		'Awaiting Removal', 'QC', 'Storage', 'Inspection'];
	const abortedStatuses = ['aborted', 'Aborted', 'cancelled', 'Cancelled'];

	const yieldPercent = producedToday > 0
		? Math.round(((producedToday - rejectedToday) / producedToday) * 1000) / 10
		: 0;
	const weeklyYieldPercent = producedWeek > 0
		? Math.round(((producedWeek - rejectedWeek) / producedWeek) * 1000) / 10
		: 0;

	// Pre-barcode funnel (production buckets) for the summary module that sits
	// under the robot grid. Read-only; a bucket-collection hiccup must not take
	// the rest of the dashboard down, hence the catch → null (module hides).
	const bucketCounts = await stageCounts().catch(() => null);

	return JSON.parse(JSON.stringify({
		robots: robotStatuses,

		bucketCounts,
		pipeline: {
			backing: {
				lots: enrichedBackingLots,

				totalReadyCartridges: enrichedBackingLots.reduce((s, bl) => s + bl.cartridgeCount, 0),
				// Individual 'backing' CartridgeRecords + legacy aggregate buckets
				backedTotal: (phaseMap.get('backing') ?? 0) + legacyBackedTotal
			},
			waxFilling: {
				inProgress: phaseMap.get('wax_filling') ?? 0,
				waxFilled: phaseMap.get('wax_filled') ?? 0,
				// Wax-stage carts eligible for reagent filling (WAX-SIMPLIFY-3)
				waxStage: WAX_STAGE_STATUSES.reduce((s, st) => s + (phaseMap.get(st) ?? 0), 0)
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

		refreshIntervalSec
	}));
};
