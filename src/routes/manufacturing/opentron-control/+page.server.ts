/**
 * Opentron Control — landing page.
 * Shows: robots (with availability), wax post-OT-2 queue, reagent post-OT-2 queue.
 */
import { redirect } from '@sveltejs/kit';
import {
	connectDB, Equipment, WaxFillingRun, ReagentBatchRecord,
	ManufacturingSettings
} from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad } from './$types';

export const config = { maxDuration: 60 };

const TERMINAL_WAX = new Set(['completed', 'aborted', 'cancelled', 'voided',
	'Completed', 'Aborted', 'Cancelled', 'Voided']);
const TERMINAL_REAGENT = new Set(['completed', 'aborted', 'voided', 'cancelled',
	'Completed', 'Aborted', 'Cancelled']);

// Stages where the operator is still actively handling the run on the filling
// page — the robot is "In Use" on the Opentron Control card until status
// moves past these. Once past (QC/Storage for wax, Top Sealing/Storage for
// reagent), the run appears in the respective post-OT-2 queue instead.
const WAX_FILLING_PAGE_STAGES = new Set([
	'Setup', 'Loading', 'Running', 'Awaiting Removal',
	'setup', 'loading', 'running', 'awaiting_removal', 'cooling'
]);
const REAGENT_FILLING_PAGE_STAGES = new Set([
	'Setup', 'Loading', 'Running', 'Inspection',
	'setup', 'loading', 'running', 'inspection'
]);

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();

	const now = Date.now();

	const [robots, settingsDoc, allWaxRuns, allReagentRuns] = await Promise.all([
		Equipment.find({ equipmentType: 'robot', isActive: true }, {
			_id: 1, name: 1, robotSide: 1
		}).sort({ name: 1 }).lean(),
		ManufacturingSettings.findById('default').lean(),
		WaxFillingRun.find(
			{ status: { $nin: [...TERMINAL_WAX] } }
		).sort({ createdAt: -1 }).lean(),
		ReagentBatchRecord.find(
			{ status: { $nin: [...TERMINAL_REAGENT] } }
		).sort({ createdAt: -1 }).lean()
	]);

	const settings = settingsDoc as any ?? {};
	const maxTimeBeforeSealMin: number = settings.reagentFilling?.maxTimeBeforeSealMin ?? 60;

	// Classify runs: robot-locking (OT-2 still running) vs post-OT-2 (queue items)
	const robotActiveWax = new Map<string, any>();
	const robotActiveReagent = new Map<string, any>();
	const waxQueue: any[] = [];
	const reagentQueue: any[] = [];

	for (const r of allWaxRuns as any[]) {
		const robotId = String(r.robot?._id ?? '');
		// Robot is "locked" while the operator is still working the run on
		// the wax-filling page (Setup → Awaiting Removal / PostRunCooling).
		// Once status passes into QC / Storage, the run hits the post-OT-2
		// queue here and the robot becomes Available.
		if (WAX_FILLING_PAGE_STAGES.has(r.status)) {
			robotActiveWax.set(robotId, r);
		} else {
			const releasedAt = r.robotReleasedAt ? new Date(r.robotReleasedAt).getTime() : now;
			waxQueue.push({
				runId: String(r._id),
				robotName: r.robot?.name ?? '',
				status: r.status,
				cartridgeCount: r.cartridgeIds?.length ?? r.plannedCartridgeCount ?? 0,
				robotReleasedAt: r.robotReleasedAt ? new Date(r.robotReleasedAt).toISOString() : null,
				elapsedSinceReleasedMin: Math.floor((now - releasedAt) / 60000),
				coolingConfirmedAt: r.coolingConfirmedTime ? new Date(r.coolingConfirmedTime).toISOString() : null,
				operatorName: r.operator?.username ?? 'Unknown'
			});
		}
	}

	for (const r of allReagentRuns as any[]) {
		const robotId = String(r.robot?._id ?? '');
		// Mirror for reagent: locked through Inspection, queued from Top
		// Sealing onward.
		if (REAGENT_FILLING_PAGE_STAGES.has(r.status)) {
			robotActiveReagent.set(robotId, r);
		} else {
			const releasedAt = r.robotReleasedAt ? new Date(r.robotReleasedAt).getTime() : now;
			const sealDeadlineMs = releasedAt + maxTimeBeforeSealMin * 60000;
			const sealOverdue = now > sealDeadlineMs;
			const sealMinRemaining = sealOverdue ? 0 : Math.ceil((sealDeadlineMs - now) / 60000);
			const sealed = (r.cartridgesFilled ?? []).filter((c: any) => c.topSealBatchId).length;
			const total = r.cartridgesFilled?.length ?? r.cartridgeCount ?? 0;

			reagentQueue.push({
				runId: String(r._id),
				robotName: r.robot?.name ?? '',
				status: r.status,
				assayTypeName: r.assayType?.name ?? '',
				cartridgeCount: total,
				sealedCount: sealed,
				robotReleasedAt: r.robotReleasedAt ? new Date(r.robotReleasedAt).toISOString() : null,
				elapsedSinceReleasedMin: Math.floor((now - releasedAt) / 60000),
				sealMinRemaining,
				sealOverdue,
				maxTimeBeforeSealMin,
				operatorName: r.operator?.username ?? 'Unknown'
			});
		}
	}

	// Build robot cards
	const robotCards = (robots as any[]).map((r: any) => {
		const robotId = String(r._id);
		const waxRun = robotActiveWax.get(robotId);
		const reagentRun = robotActiveReagent.get(robotId);

		let status: string;
		let displayStatus: string;
		let activeRunId: string | null = null;
		let activeProcess: string | null = null;

		if (waxRun) {
			status = 'running_wax';
			displayStatus = `Wax Filling — ${waxRun.status}`;
			activeRunId = String(waxRun._id);
			activeProcess = 'wax';
		} else if (reagentRun) {
			status = 'running_reagent';
			displayStatus = `Reagent Filling — ${reagentRun.status}`;
			activeRunId = String(reagentRun._id);
			activeProcess = 'reagent';
		} else {
			status = 'available';
			displayStatus = 'Available';
		}

		return {
			robotId,
			name: r.name ?? '',
			description: r.robotSide ?? null,
			status,
			displayStatus,
			activeRunId,
			activeProcess
		};
	});

	return {
		robotCards: JSON.parse(JSON.stringify(robotCards)),
		waxQueue: JSON.parse(JSON.stringify(waxQueue)),
		reagentQueue: JSON.parse(JSON.stringify(reagentQueue)),
		maxTimeBeforeSealMin
	};
};
