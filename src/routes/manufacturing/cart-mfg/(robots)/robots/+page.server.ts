/**
 * Robots page — the live command view (ROBOT-OVERHAUL round 6, 2026-10-08;
 * inline setup 2026-10-14).
 *
 * One panel per active robot, always:
 *   • running (wax 'Running' / 'Awaiting Removal', reagent 'Running'): that
 *     robot's wizard in run mode (timer, robot controller, tip swap, well
 *     tracker, finish) — loaded here with the former single-robot page load;
 *   • setting up (a run in Setup / Loading): that robot's wizard in PANEL mode,
 *     right here — the same load the wax-filling / reagent-filling page does;
 *   • idle: "Start wax" / "Start reagent" open the setup wizard in the panel
 *     (`?open=<robotId>:<process>`, see $lib/manufacturing/robot-panels) — the
 *     robot stays idle until the wizard creates its run.
 * Nothing on this page navigates away any more. A robot whose process the
 * user may not read keeps the old "continue on its page" link (kind 'setup').
 * Finishing a run on this page drops the robot back to idle in place.
 */
import { redirect } from '@sveltejs/kit';
import { hasPermission } from '$lib/server/permissions';
import { OPEN_PARAM, parseOpen, type BoardProcess } from '$lib/manufacturing/robot-panels';
import { loadWaxWizard, type WaxWizardData } from '$lib/server/manufacturing/wax-wizard';
import { loadReagentWizard, type ReagentWizardData } from '$lib/server/manufacturing/reagent-wizard';
import { connectDB, ReagentBatchRecord } from '$lib/server/db';
import { POST_RUN_WELL_LOG_HOURS } from '$lib/manufacturing/reagent-well-issues';
import type { PageServerLoad } from './$types';

export const config = { maxDuration: 60 };

type PanelBase = { robotId: string; robotName: string; process: BoardProcess | null; stage: string | null; live: boolean };
export type RobotPanel =
	/** lastReagentRunFinishedAt: a Completed reagent run whose post-run well log is still open. */
	| (PanelBase & { kind: 'idle'; process: null; live: false; lastReagentRunFinishedAt: string | null })
	/** A run in setup whose wizard the user may not read — link to its page only. */
	| (PanelBase & { kind: 'setup'; process: BoardProcess; live: false })
	| (PanelBase & { kind: 'wax-setup'; process: 'wax'; live: false; data: WaxWizardData })
	| (PanelBase & { kind: 'reagent-setup'; process: 'reagent'; live: false; data: ReagentWizardData })
	| (PanelBase & { kind: 'wax'; process: 'wax'; live: true; data: WaxWizardData })
	| (PanelBase & { kind: 'reagent'; process: 'reagent'; live: true; data: ReagentWizardData });

const WAX_LIVE = new Set(['Running', 'running', 'Awaiting Removal', 'awaiting_removal', 'cooling']);
const REAGENT_LIVE = new Set(['Running', 'running']);

export const load: PageServerLoad = async ({ locals, parent, url }) => {
	if (!locals.user) redirect(302, '/login');
	const { board } = await parent();
	const may: Record<BoardProcess, boolean> = {
		wax: hasPermission(locals.user, 'waxFilling:read'),
		reagent: hasPermission(locals.user, 'reagentFilling:read')
	};
	const open = parseOpen(url.searchParams.get(OPEN_PARAM));
	await connectDB();

	const panels = await Promise.all(
		board.map(async (row): Promise<RobotPanel> => {
			const base = { robotId: row.robotId, robotName: row.name };

			// The setup wizard in the panel (same load as the standalone setup
			// page); the link-only fallback when the user may not read it.
			const setupPanel = async (process: BoardProcess, stage: string | null): Promise<RobotPanel> => {
				if (process === 'wax' && may.wax) {
					return { ...base, kind: 'wax-setup', process: 'wax', stage, live: false, data: await loadWaxWizard(locals, row.robotId, row.name) };
				}
				if (process === 'reagent' && may.reagent) {
					return { ...base, kind: 'reagent-setup', process: 'reagent', stage, live: false, data: await loadReagentWizard(locals, row.robotId) };
				}
				return { ...base, kind: 'setup', process, stage, live: false };
			};

			if (row.wax) {
				const stage = row.wax.stage;
				if (WAX_LIVE.has(stage) && may.wax) {
					return { ...base, kind: 'wax', process: 'wax', stage, live: true, data: await loadWaxWizard(locals, row.robotId, row.name) };
				}
				return setupPanel('wax', stage);
			}
			if (row.reagent) {
				const stage = row.reagent.stage;
				if (REAGENT_LIVE.has(stage) && may.reagent) {
					return { ...base, kind: 'reagent', process: 'reagent', stage, live: true, data: await loadReagentWizard(locals, row.robotId) };
				}
				return setupPanel('reagent', stage);
			}
			// Idle: open only if the operator asked for it (?open=) and may read it.
			const want = open[row.robotId];
			if (want && may[want]) return setupPanel(want, null);
			// Post-run well log: point the operator at the last reagent run while it is
			// still open, so mistakes seen while unloading can be logged.
			let lastReagentRunFinishedAt: string | null = null;
			if (may.reagent) {
				const since = new Date(Date.now() - POST_RUN_WELL_LOG_HOURS * 3_600_000);
				const last = (await ReagentBatchRecord.findOne({ 'robot._id': row.robotId, status: 'Completed', finalizedAt: { $gte: since } })
					.select('finalizedAt')
					.sort({ finalizedAt: -1 })
					.lean()
					.catch(() => null)) as any;
				if (last?.finalizedAt) lastReagentRunFinishedAt = new Date(last.finalizedAt).toISOString();
			}
			return { ...base, kind: 'idle', process: null, stage: null, live: false, lastReagentRunFinishedAt };
		})
	);

	return { panels, may };
};
