/**
 * Resource-lock checks for wax / reagent filling runs.
 *
 * Enforces that at any moment:
 *   - one non-terminal run per robot (across both wax AND reagent)
 *   - one non-terminal run per deck (across both collections)
 *   - one non-terminal run per tray (across both collections)
 *
 * Per-collection uniqueness is also enforced by partial unique indexes on
 * WaxFillingRun / ReagentBatchRecord (see each schema). These app-layer
 * checks catch cross-process conflicts that the DB cannot — e.g. a deck
 * already bound to a reagent run can't be used by a new wax run.
 *
 * All helpers return null on success or an error message string on conflict.
 */
import { WaxFillingRun, ReagentBatchRecord } from '$lib/server/db';

const WAX_NON_TERMINAL = ['Setup', 'Loading', 'Running', 'Awaiting Removal', 'QC', 'Storage',
	'setup', 'loading', 'running', 'awaiting_removal', 'cooling', 'qc', 'storage'];

const REAGENT_NON_TERMINAL = ['Setup', 'Loading', 'Running', 'Inspection', 'Top Sealing', 'Storage',
	'setup', 'loading', 'running', 'inspection', 'top_sealing', 'storage'];

const WAX_PAGE_OWNED = ['Setup', 'Loading', 'Running', 'Awaiting Removal',
	'setup', 'loading', 'running', 'awaiting_removal', 'cooling'];
const REAGENT_PAGE_OWNED = ['Setup', 'Loading', 'Running', 'Inspection',
	'setup', 'loading', 'running', 'inspection'];

/** Is any wax OR reagent run on this robot in a page-owned stage? */
export async function checkRobotConflict(robotId: string): Promise<string | null> {
	if (!robotId) return null;
	const [wax, reagent] = await Promise.all([
		WaxFillingRun.findOne({ 'robot._id': robotId, status: { $in: WAX_PAGE_OWNED } })
			.select('_id status').lean() as any,
		ReagentBatchRecord.findOne({ 'robot._id': robotId, status: { $in: REAGENT_PAGE_OWNED } })
			.select('_id status').lean() as any
	]);
	if (wax) return `Robot already has an active wax run (${wax.status}). Finish or cancel it first.`;
	if (reagent) return `Robot already has an active reagent run (${reagent.status}). Finish or cancel it first.`;
	return null;
}

/**
 * Is this deck bound to any run that still physically has it?
 * The deck is only truly "in use" during page-owned stages. Once status
 * moves past the filling page (QC/Storage for wax, Top Sealing/Storage
 * for reagent), the cartridges are off the deck and it's free for reuse.
 */
export async function checkDeckConflict(deckId: string, ignoreRunId?: string): Promise<string | null> {
	if (!deckId) return null;
	const [wax, reagent] = await Promise.all([
		WaxFillingRun.findOne({
			deckId,
			status: { $in: WAX_PAGE_OWNED },
			...(ignoreRunId ? { _id: { $ne: ignoreRunId } } : {})
		}).select('_id status').lean() as any,
		ReagentBatchRecord.findOne({
			deckId,
			status: { $in: REAGENT_PAGE_OWNED },
			...(ignoreRunId ? { _id: { $ne: ignoreRunId } } : {})
		}).select('_id status').lean() as any
	]);
	if (wax) return `Deck "${deckId}" is on wax run ${String(wax._id).slice(-8)} (${wax.status}). Complete that run first.`;
	if (reagent) return `Deck "${deckId}" is on reagent run ${String(reagent._id).slice(-8)} (${reagent.status}). Complete that run first.`;
	return null;
}

/** Is this tray bound to any non-terminal wax (coolingTrayId) OR reagent (trayId) run? */
export async function checkTrayConflict(trayId: string, ignoreRunId?: string): Promise<string | null> {
	if (!trayId) return null;
	const [wax, reagent] = await Promise.all([
		WaxFillingRun.findOne({
			coolingTrayId: trayId,
			status: { $in: WAX_NON_TERMINAL },
			...(ignoreRunId ? { _id: { $ne: ignoreRunId } } : {})
		}).select('_id status').lean() as any,
		ReagentBatchRecord.findOne({
			trayId,
			status: { $in: REAGENT_NON_TERMINAL },
			...(ignoreRunId ? { _id: { $ne: ignoreRunId } } : {})
		}).select('_id status').lean() as any
	]);
	if (wax) return `Tray "${trayId}" is on wax run ${String(wax._id).slice(-8)} (${wax.status}). Pick a different tray.`;
	if (reagent) return `Tray "${trayId}" is on reagent run ${String(reagent._id).slice(-8)} (${reagent.status}). Pick a different tray.`;
	return null;
}
