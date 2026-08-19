/**
 * Shared robot-status cards + the wax post-OT-2 queue.
 * Used by the Opentron Control hub (backup route) and the wax-filling /
 * reagent-filling pages' robot-select start screens (WAX-FLOW-1).
 *
 * REAGENT-TOPSEAL-IMPLICIT (2026-08-19): the reagent post-OT-2 queue
 * (Top Sealing / Storage) is gone — reagent runs finish at Running, so there
 * is no `reagentQueue` any more. Only wax has a post-OT-2 queue.
 */
import {
	Equipment, WaxFillingRun, ReagentBatchRecord, CartridgeRecord
} from '$lib/server/db';

const TERMINAL_WAX = new Set(['completed', 'aborted', 'cancelled', 'voided',
	'Completed', 'Aborted', 'Cancelled', 'Voided']);
const TERMINAL_REAGENT = new Set(['completed', 'aborted', 'voided', 'cancelled',
	'Completed', 'Aborted', 'Cancelled']);

// Stages where the operator is still actively handling the run on the filling
// page — the robot is "In Use" until status moves past these. Once past
// (QC/Storage for wax), the run appears in the wax post-OT-2 queue instead.
// Reagent runs have no post-OT-2 stages: the next status is terminal.
export const WAX_FILLING_PAGE_STAGES = new Set([
	'Setup', 'Loading', 'Running', 'Awaiting Removal',
	'setup', 'loading', 'running', 'awaiting_removal', 'cooling'
]);
export const REAGENT_FILLING_PAGE_STAGES = new Set([
	'Setup', 'Loading', 'Running', 'Inspection',
	'setup', 'loading', 'running', 'inspection'
]);

export interface RobotCard {
	robotId: string;
	name: string;
	description: string | null;
	status: 'available' | 'running_wax' | 'running_reagent';
	displayStatus: string;
	activeRunId: string | null;
	activeProcess: 'wax' | 'reagent' | null;
}

export async function loadRobotCardsAndQueues() {
	const now = Date.now();

	const [robots, allWaxRuns, allReagentRuns] = await Promise.all([
		Equipment.find({ equipmentType: 'robot', isActive: true }, {
			_id: 1, name: 1, robotSide: 1
		}).sort({ name: 1 }).lean(),
		WaxFillingRun.find(
			{ status: { $nin: [...TERMINAL_WAX] } }
		).sort({ createdAt: -1 }).lean(),
		ReagentBatchRecord.find(
			{ status: { $nin: [...TERMINAL_REAGENT] } }
		).sort({ createdAt: -1 }).lean()
	]);

	// Robot ID → name map. Reagent runs sometimes only have robot._id set (no
	// name embedded), so queue rows were rendering the raw ID.
	const robotNameById = new Map<string, string>();
	for (const r of robots as any[]) robotNameById.set(String(r._id), r.name ?? '');
	const resolveRobotName = (run: any): string =>
		run?.robot?.name || robotNameById.get(String(run?.robot?._id ?? '')) || 'Unknown';

	// Batch-fetch storage locations for every wax run in the queue — one
	// query for all cartridges, then group by runId.
	const waxRunIds = (allWaxRuns as any[])
		.filter((r) => !WAX_FILLING_PAGE_STAGES.has(r.status))
		.flatMap((r) => r.cartridgeIds ?? []);
	const waxStorageByRun = new Map<string, Set<string>>();
	if (waxRunIds.length > 0) {
		const storedCarts = await CartridgeRecord.find(
			{ _id: { $in: waxRunIds }, 'storage.fridgeName': { $exists: true } },
			{ _id: 1, 'waxFilling.runId': 1, 'storage.fridgeName': 1, 'storage.locationId': 1 }
		).lean() as any[];
		for (const c of storedCarts) {
			const rid = c.waxFilling?.runId ? String(c.waxFilling.runId) : null;
			const fridge = c.storage?.fridgeName || c.storage?.locationId;
			if (rid && fridge) {
				if (!waxStorageByRun.has(rid)) waxStorageByRun.set(rid, new Set());
				waxStorageByRun.get(rid)!.add(String(fridge));
			}
		}
	}
	const summarizeFridges = (set: Set<string> | undefined): string | null => {
		if (!set || set.size === 0) return null;
		const arr = [...set];
		if (arr.length === 1) return arr[0];
		return `${arr[0]} +${arr.length - 1}`;
	};

	// Classify runs: robot-locking (OT-2 still running) vs post-OT-2 (queue items)
	const robotActiveWax = new Map<string, any>();
	const robotActiveReagent = new Map<string, any>();
	const waxQueue: any[] = [];

	for (const r of allWaxRuns as any[]) {
		const robotId = String(r.robot?._id ?? '');
		if (WAX_FILLING_PAGE_STAGES.has(r.status)) {
			robotActiveWax.set(robotId, r);
		} else {
			const releasedAt = r.robotReleasedAt ? new Date(r.robotReleasedAt).getTime() : now;
			waxQueue.push({
				runId: String(r._id),
				robotName: resolveRobotName(r),
				status: r.status,
				cartridgeCount: r.cartridgeIds?.length ?? r.plannedCartridgeCount ?? 0,
				robotReleasedAt: r.robotReleasedAt ? new Date(r.robotReleasedAt).toISOString() : null,
				elapsedSinceReleasedMin: Math.floor((now - releasedAt) / 60000),
				coolingConfirmedAt: r.coolingConfirmedTime ? new Date(r.coolingConfirmedTime).toISOString() : null,
				operatorName: r.operator?.username ?? 'Unknown',
				trayId: r.coolingTrayId ?? null,
				fridgeLocation: summarizeFridges(waxStorageByRun.get(String(r._id)))
			});
		}
	}

	for (const r of allReagentRuns as any[]) {
		const robotId = String(r.robot?._id ?? '');
		// Only page-owned stages lock the robot. Any legacy post-OT-2 status
		// ('Top Sealing' / 'Storage', pre-migration) is ignored here — the
		// migrate-retire-top-sealing script closes those out.
		if (REAGENT_FILLING_PAGE_STAGES.has(r.status)) {
			robotActiveReagent.set(robotId, r);
		}
	}

	const robotCards: RobotCard[] = (robots as any[]).map((r: any) => {
		const robotId = String(r._id);
		const waxRun = robotActiveWax.get(robotId);
		const reagentRun = robotActiveReagent.get(robotId);

		let status: RobotCard['status'];
		let displayStatus: string;
		let activeRunId: string | null = null;
		let activeProcess: RobotCard['activeProcess'] = null;

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

	return { robotCards, waxQueue };
}
