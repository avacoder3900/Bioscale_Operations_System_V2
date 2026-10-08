/**
 * Robots page — the live command view (ROBOT-OVERHAUL round 6, 2026-10-08).
 *
 * One panel per active robot, always:
 *   • running (wax 'Running' / 'Awaiting Removal', reagent 'Running'): that
 *     robot's wizard in run mode (timer, robot controller, tip swap, well
 *     tracker, finish) — loaded here with the former single-robot page load;
 *   • setting up (a run in Setup / Loading): a "continue setup" link to the
 *     wax-filling / reagent-filling page, which owns setup;
 *   • idle: "Start wax" / "Start reagent" buttons to those setup pages.
 * Finishing a run on this page drops the robot back to idle in place.
 */
import { redirect } from '@sveltejs/kit';
import { hasPermission } from '$lib/server/permissions';
import type { BoardProcess } from '$lib/manufacturing/robot-panels';
import { loadWaxWizard, type WaxWizardData } from '$lib/server/manufacturing/wax-wizard';
import { loadReagentWizard, type ReagentWizardData } from '$lib/server/manufacturing/reagent-wizard';
import type { PageServerLoad } from './$types';

export const config = { maxDuration: 60 };

type PanelBase = { robotId: string; robotName: string; process: BoardProcess | null; stage: string | null; live: boolean };
export type RobotPanel =
	| (PanelBase & { kind: 'idle'; process: null; live: false })
	| (PanelBase & { kind: 'setup'; process: BoardProcess; live: false })
	| (PanelBase & { kind: 'wax'; process: 'wax'; live: true; data: WaxWizardData })
	| (PanelBase & { kind: 'reagent'; process: 'reagent'; live: true; data: ReagentWizardData });

const WAX_LIVE = new Set(['Running', 'running', 'Awaiting Removal', 'awaiting_removal', 'cooling']);
const REAGENT_LIVE = new Set(['Running', 'running']);

export const load: PageServerLoad = async ({ locals, parent }) => {
	if (!locals.user) redirect(302, '/login');
	const { board } = await parent();
	const may: Record<BoardProcess, boolean> = {
		wax: hasPermission(locals.user, 'waxFilling:read'),
		reagent: hasPermission(locals.user, 'reagentFilling:read')
	};

	const panels = await Promise.all(
		board.map(async (row): Promise<RobotPanel> => {
			const base = { robotId: row.robotId, robotName: row.name };
			if (row.wax) {
				const stage = row.wax.stage;
				if (WAX_LIVE.has(stage) && may.wax) {
					return { ...base, kind: 'wax', process: 'wax', stage, live: true, data: await loadWaxWizard(locals, row.robotId, row.name) };
				}
				return { ...base, kind: 'setup', process: 'wax', stage, live: false };
			}
			if (row.reagent) {
				const stage = row.reagent.stage;
				if (REAGENT_LIVE.has(stage) && may.reagent) {
					return { ...base, kind: 'reagent', process: 'reagent', stage, live: true, data: await loadReagentWizard(locals, row.robotId) };
				}
				return { ...base, kind: 'setup', process: 'reagent', stage, live: false };
			}
			return { ...base, kind: 'idle', process: null, stage: null, live: false };
		})
	);

	return { panels, may };
};
