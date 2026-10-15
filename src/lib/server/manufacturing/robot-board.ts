/**
 * Robot board — the ONE server read behind the Robots page group
 * (/manufacturing/cart-mfg/robots plus the wax-filling and reagent-filling
 * wizards under it). One row per active OT-2: its bridge health, the run,
 * if any, that EACH process (wax, reagent) currently has on it, and which
 * process it ran last (the wizard an idle robot's panel opens on).
 *
 * ROBOT-OVERHAUL (2026-10-07): replaces the three near-identical loads that
 * lived in wax-filling/+layout.server.ts, reagent-filling/+layout.server.ts and
 * the old opentrons/+page.server.ts (robot-cards.ts, whose wax queue nothing
 * rendered any more, went with them).
 */
import { Equipment, WaxFillingRun, ReagentBatchRecord } from '$lib/server/db';
import { getRobotsHealth, type RobotHealth } from '$lib/server/opentrons/health';
import type { BoardProcess } from '$lib/manufacturing/robot-panels';
import { WAX_PAGE_OWNED, REAGENT_PAGE_OWNED } from './run-statuses';

export type { RobotHealth } from '$lib/server/opentrons/health';
export type { BoardProcess } from '$lib/manufacturing/robot-panels';

/** The run a process currently has on a robot (page-owned stages only). */
export interface BoardRun {
	runId: string;
	stage: string;
	startTime: string | null;
	cartridgeCount: number;
	/** Wax runs: the deck that was scanned in. */
	deckId: string | null;
	/** Reagent runs: the assay being filled. */
	assayTypeName: string | null;
}

export interface RobotBoardRow {
	robotId: string;
	name: string;
	side: string | null;
	health: RobotHealth | null;
	wax: BoardRun | null;
	reagent: BoardRun | null;
	/** The process this robot ran most recently (null = never ran). */
	lastProcess: BoardProcess | null;
}

export interface RobotBoard {
	/** Same shape the wizard loads read (`layoutData.robots[0].robotId` fallback). */
	robots: { robotId: string; name: string; description: string | null }[];
	board: RobotBoardRow[];
}

const iso = (d: unknown): string | null => (d ? new Date(d as string | number | Date).toISOString() : null);

/** robotId → createdAt (ms) of that robot's newest run in a collection. */
async function newestRunByRobot(model: typeof WaxFillingRun | typeof ReagentBatchRecord): Promise<Map<string, number>> {
	const rows = (await model
		.aggregate([{ $sort: { createdAt: -1 } }, { $group: { _id: '$robot._id', at: { $first: '$createdAt' } } }])
		.catch(() => [])) as { _id: unknown; at: unknown }[];
	const m = new Map<string, number>();
	for (const r of rows) {
		const t = r.at ? new Date(r.at as string).getTime() : NaN;
		if (r._id && Number.isFinite(t)) m.set(String(r._id), t);
	}
	return m;
}

export async function loadRobotBoard(): Promise<RobotBoard> {
	const [robots, waxRuns, reagentRuns, lastWaxAt, lastReagentAt] = await Promise.all([
		Equipment.find({ equipmentType: 'robot', isActive: true }, { _id: 1, name: 1, robotSide: 1 })
			.sort({ name: 1 })
			.lean(),
		// A robot is "in use" by a process only while its run sits in a page-owned
		// stage; anything past that (or terminal) frees the robot.
		WaxFillingRun.find(
			{ status: { $in: [...WAX_PAGE_OWNED] } },
			{ 'robot._id': 1, status: 1, runStartTime: 1, deckId: 1, cartridgeIds: 1, plannedCartridgeCount: 1 }
		).lean(),
		ReagentBatchRecord.find(
			{ status: { $in: [...REAGENT_PAGE_OWNED] } },
			{ 'robot._id': 1, status: 1, runStartTime: 1, cartridgeCount: 1, 'assayType.name': 1 }
		)
			.lean()
			.catch(() => [] as any[]),
		newestRunByRobot(WaxFillingRun),
		newestRunByRobot(ReagentBatchRecord)
	]);

	// Bridge-heartbeat health (ready / busy / hung / offline) per robot — the
	// board polls /api/opentrons-lab/robots/health for the same shape afterwards.
	const health = await getRobotsHealth(
		(robots as any[]).map((r) => ({ _id: String(r._id), name: r.name }))
	).catch(() => ({}) as Record<string, RobotHealth>);

	const board: RobotBoardRow[] = (robots as any[]).map((r) => {
		const robotId = String(r._id);
		const w = (waxRuns as any[]).find((x) => String(x.robot?._id) === robotId);
		const g = (reagentRuns as any[]).find((x) => String(x.robot?._id) === robotId);
		const wAt = lastWaxAt.get(robotId) ?? 0;
		const gAt = lastReagentAt.get(robotId) ?? 0;
		return {
			robotId,
			name: r.name ?? '',
			side: r.robotSide ?? null,
			health: health[robotId] ?? null,
			wax: w
				? {
						runId: String(w._id),
						stage: String(w.status ?? ''),
						startTime: iso(w.runStartTime),
						cartridgeCount: w.cartridgeIds?.length ?? w.plannedCartridgeCount ?? 0,
						deckId: w.deckId ?? null,
						assayTypeName: null
					}
				: null,
			reagent: g
				? {
						runId: String(g._id),
						stage: String(g.status ?? ''),
						startTime: iso(g.runStartTime),
						cartridgeCount: g.cartridgeCount ?? 0,
						deckId: null,
						assayTypeName: g.assayType?.name ?? null
					}
				: null,
			lastProcess: wAt === 0 && gAt === 0 ? null : wAt >= gAt ? 'wax' : 'reagent'
		};
	});

	return {
		robots: board.map((b) => ({ robotId: b.robotId, name: b.name, description: b.side })),
		board
	};
}
