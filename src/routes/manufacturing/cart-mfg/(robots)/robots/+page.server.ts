/**
 * Robots page — every open wizard at once (ROBOT-OVERHAUL round 2, 2026-10-07).
 *
 * One panel per robot: the process that has a run in progress is always open;
 * an idle robot's panel opens when the operator picks Start on the board
 * (?open=<robotId>:wax|reagent, see $lib/manufacturing/robot-panels). Each
 * panel's data is the former single-robot page load, now a lib function, so
 * three robots cost one page load instead of three tabs.
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
	const requested = parseOpenPanels(url.searchParams.get('open'));
	const may: Record<BoardProcess, boolean> = {
		wax: hasPermission(locals.user, 'waxFilling:read'),
		reagent: hasPermission(locals.user, 'reagentFilling:read')
	};

	const panels = await Promise.all(
		board.map(async (row): Promise<RobotPanel | null> => {
			const active: BoardProcess | null = row.wax ? 'wax' : row.reagent ? 'reagent' : null;
			const process = active ?? requested.get(row.robotId) ?? null;
			if (!process || !may[process]) return null;
			const base = { robotId: row.robotId, robotName: row.name, forced: active !== null };
			return process === 'wax'
				? { ...base, process, data: await loadWaxWizard(locals, row.robotId, row.name) }
				: { ...base, process, data: await loadReagentWizard(locals, row.robotId) };
		})
	);

	return { panels: panels.filter((p): p is RobotPanel => p !== null) };
};
