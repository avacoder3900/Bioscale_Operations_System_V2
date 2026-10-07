/**
 * Robots page — every robot's wizard, all at once (ROBOT-OVERHAUL round 3,
 * 2026-10-07).
 *
 * One panel per active robot, always. The panel shows the process that has a
 * run in progress; an idle robot shows whichever the operator picked on its
 * Wax | Reagent toggle (?open=<robotId>:wax|reagent, see
 * $lib/manufacturing/robot-panels), else the process that robot ran last,
 * else wax. Each panel's data is the former single-robot page load, now a lib
 * function, so three robots cost one page load instead of three tabs.
 */
import { redirect } from '@sveltejs/kit';
import { hasPermission } from '$lib/server/permissions';
import { parseOpenPanels, type BoardProcess } from '$lib/manufacturing/robot-panels';
import { loadWaxWizard, type WaxWizardData } from '$lib/server/manufacturing/wax-wizard';
import { loadReagentWizard, type ReagentWizardData } from '$lib/server/manufacturing/reagent-wizard';
import type { PageServerLoad } from './$types';

export const config = { maxDuration: 60 };

export type RobotPanel =
	| { robotId: string; robotName: string; process: 'wax'; forced: boolean; data: WaxWizardData }
	| { robotId: string; robotName: string; process: 'reagent'; forced: boolean; data: ReagentWizardData };

export const load: PageServerLoad = async ({ locals, url, parent }) => {
	if (!locals.user) redirect(302, '/login');
	const { board } = await parent();
	const chosen = parseOpenPanels(url.searchParams.get('open'));
	const may: Record<BoardProcess, boolean> = {
		wax: hasPermission(locals.user, 'waxFilling:read'),
		reagent: hasPermission(locals.user, 'reagentFilling:read')
	};
	const other = (p: BoardProcess): BoardProcess => (p === 'wax' ? 'reagent' : 'wax');

	const panels = await Promise.all(
		board.map(async (row): Promise<RobotPanel | null> => {
			const active: BoardProcess | null = row.wax ? 'wax' : row.reagent ? 'reagent' : null;
			let process: BoardProcess = active ?? chosen.get(row.robotId) ?? row.lastProcess ?? 'wax';
			// A reader of only one process still gets a panel — the one they may see.
			if (!may[process] && !active && may[other(process)]) process = other(process);
			if (!may[process]) return null;
			const base = { robotId: row.robotId, robotName: row.name, forced: active !== null };
			return process === 'wax'
				? { ...base, process, data: await loadWaxWizard(locals, row.robotId, row.name) }
				: { ...base, process, data: await loadReagentWizard(locals, row.robotId) };
		})
	);

	return { panels: panels.filter((p): p is RobotPanel => p !== null) };
};
