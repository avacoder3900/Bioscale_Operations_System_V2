import { json } from '@sveltejs/kit';
import {
	connectDB, WaxFillingRun, ReagentBatchRecord, CartridgeRecord,
	BackingLot, Consumable, ManufacturingSettings,
	OpentronsRobot, ManufacturingMaterial, LaserCutBatch,
	BarcodeSheetBatch, BarcodeInventory, ShippingLot
} from '$lib/server/db';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	await connectDB();

	const now = Date.now();
	const todayStart = new Date();
	todayStart.setHours(0, 0, 0, 0);

	const [
		robots,
		settingsDoc,
		activeWaxRuns,
		activeReagentRuns,
		phaseCounts,
		barcodeInventory,
		topSealRolls
	] = await Promise.all([
		OpentronsRobot.find({}).select('_id name').lean(),
		ManufacturingSettings.findById('default').lean(),
		WaxFillingRun.find({
			status: { $nin: ['completed', 'aborted', 'cancelled', 'voided',
				'Completed', 'Aborted', 'Cancelled', 'Voided'] }
		}).select('robot status operator cartridgeIds plannedCartridgeCount runStartTime waxSourceLot updatedAt').lean(),
		ReagentBatchRecord.find({
			status: { $nin: ['completed', 'aborted', 'cancelled', 'voided',
				'Completed', 'Aborted', 'Cancelled'] }
		}).select('robot status operator assayType cartridgeCount cartridgesFilled runStartTime updatedAt').lean(),
		CartridgeRecord.aggregate([
			{ $group: { _id: '$currentPhase', count: { $sum: 1 } } }
		]),
		BarcodeInventory.findById('default').lean(),
		Consumable.find({ type: 'top_seal_roll', status: 'active' })
			.select('_id barcode remainingLengthFt').lean()
	]);

	const settings = settingsDoc as any ?? {};
	const robotStallWarningMin: number = settings?.general?.robotStallWarningMin ?? 90;

	const phaseMap = new Map<string, number>(
		phaseCounts.map((p: any) => [p._id ?? 'unknown', p.count])
	);

	const WAX_ACTIVE = ['Setup', 'Loading', 'Running', 'setup', 'loading', 'running'];
	const WAX_DECK_FREE = ['Awaiting Removal', 'QC', 'Storage', 'awaiting_removal', 'qc', 'storage'];
	const REAGENT_ACTIVE = ['Setup', 'Loading', 'Running', 'setup', 'loading', 'running'];
	const REAGENT_DECK_FREE = ['Inspection', 'Top Sealing', 'Storage'];

	const robotStatuses = (robots as any[]).map((robot: any) => {
		const robotId = String(robot._id);
		const waxRun = (activeWaxRuns as any[]).find(r => String(r.robot?._id) === robotId);
		const reagentRun = (activeReagentRuns as any[]).find(r => String(r.robot?._id) === robotId);

		let status: string;
		let displayStatus: string;
		let robotPhysicallyFree: boolean;

		if (waxRun && WAX_ACTIVE.includes(waxRun.status)) {
			status = 'running_wax'; displayStatus = `Running — Wax Fill (${waxRun.status})`; robotPhysicallyFree = false;
		} else if (reagentRun && REAGENT_ACTIVE.includes(reagentRun.status)) {
			status = 'running_reagent'; displayStatus = `Running — Reagent Fill (${reagentRun.status})`; robotPhysicallyFree = false;
		} else if (waxRun && WAX_DECK_FREE.includes(waxRun.status)) {
			status = 'deck_free_wax'; displayStatus = `Robot Free — Wax run: ${waxRun.status}`; robotPhysicallyFree = true;
		} else if (reagentRun && REAGENT_DECK_FREE.includes(reagentRun.status)) {
			status = 'deck_free_reagent'; displayStatus = `Robot Free — Reagent run: ${reagentRun.status}`; robotPhysicallyFree = true;
		} else {
			status = 'available'; displayStatus = 'Available'; robotPhysicallyFree = true;
		}

		const activeRun = waxRun ?? reagentRun;
		const runStartTime = activeRun?.runStartTime;
		const elapsedMs = runStartTime ? now - new Date(runStartTime).getTime() : 0;

		return {
			robotId,
			name: robot.name ?? robotId,
			status, displayStatus, robotPhysicallyFree,
			elapsedMin: Math.floor(elapsedMs / 60000),
			activeWaxRun: waxRun ? { runId: String(waxRun._id), stage: waxRun.status, operatorUsername: waxRun.operator?.username ?? null } : null,
			activeReagentRun: reagentRun ? { runId: String(reagentRun._id), stage: reagentRun.status, operatorUsername: reagentRun.operator?.username ?? null } : null
		};
	});

	const barcodeInv = barcodeInventory as any;

	return json({
		robots: robotStatuses,
		phaseCounts: Object.fromEntries(phaseMap),
		barcodeSheets: barcodeInv?.avery94102SheetsOnHand ?? 0,
		topSealRolls: (topSealRolls as any[]).length,
		timestamp: new Date().toISOString()
	});
};
