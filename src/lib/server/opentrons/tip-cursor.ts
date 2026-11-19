/**
 * Where the next FRESH tip is on a robot's rack, for the Deck Calibration Studio.
 *
 * The fill protocols track consumption in a per-robot, per-rack tracker file on
 * the robot and stamp its final index onto the run record (pipetteTipState.after).
 * The Studio used to aim every pick-up at A1 regardless — on a rack whose first
 * columns had been used by runs it pressed into empty positions and looked like
 * "doesn't go deep enough" (B14, 2026-09-24). This module answers "which well
 * next?" from the newer of two sources:
 *   - the latest run's after-state for that profile (reagent → ReagentBatchRecord,
 *     wax → WaxFillingRun), which is what the robot's tracker holds after a run;
 *   - the Studio's own cursor on the robot record, advanced on every Studio pick-up
 *     (the protocols never learn about those, see the note in progress.txt).
 * Rack order is column-major: A1..H1, A2..H2, … H12.
 */
import { connectDB, OpentronsRobot, ReagentBatchRecord, WaxFillingRun } from '$lib/server/db';

export type TipProfile = 'wax' | 'reagent';
const ROWS = 'ABCDEFGH';

export function wellFromIndex(i: number): string {
	const n = ((Math.floor(i) % 96) + 96) % 96;
	return `${ROWS[n % 8]}${Math.floor(n / 8) + 1}`;
}

export function indexFromWell(w: string): number | null {
	const m = /^([A-H])(\d{1,2})$/.exec(String(w).trim().toUpperCase());
	if (!m) return null;
	const col = parseInt(m[2], 10);
	if (col < 1 || col > 12) return null;
	return (col - 1) * 8 + ROWS.indexOf(m[1]);
}

/** Which tip profile a tiprack belongs to (the wax rack is the 20µL one). */
export function profileForTiprack(loadName: string): TipProfile {
	return /20ul/i.test(loadName) ? 'wax' : 'reagent';
}

export async function nextStudioTipWell(
	robotId: string,
	profile: TipProfile
): Promise<{ well: string; index: number; source: 'run' | 'studio' | 'manual' | 'default'; at: Date | null }> {
	await connectDB();
	const Model: any = profile === 'reagent' ? ReagentBatchRecord : WaxFillingRun;
	const lastRun = (await Model.findOne({ 'robot._id': robotId, 'pipetteTipState.after.nextTipIndex': { $exists: true } })
		.sort({ 'pipetteTipState.after.capturedAt': -1 })
		.select('pipetteTipState')
		.lean()) as any;
	const runIdx = Number(lastRun?.pipetteTipState?.after?.nextTipIndex);
	const runAt = lastRun?.pipetteTipState?.after?.capturedAt ? new Date(lastRun.pipetteTipState.after.capturedAt) : null;

	const robot = (await OpentronsRobot.findById(robotId).select('studioTip').lean()) as any;
	const cur = robot?.studioTip?.[profile];
	const curIdx = Number(cur?.index);
	const curAt = cur?.at ? new Date(cur.at) : null;

	const haveRun = Number.isFinite(runIdx) && runAt;
	const haveCur = Number.isFinite(curIdx) && curAt;
	// Set by hand on the Run tab (2026-11-19): it IS the next tip until a run has
	// started from it (clearManualTip), whatever the last run recorded.
	if (haveCur && cur?.manual === true) return { well: wellFromIndex(curIdx), index: curIdx, source: 'manual', at: curAt };
	if (haveRun && haveCur) {
		return curAt! > runAt! ? { well: wellFromIndex(curIdx), index: curIdx, source: 'studio', at: curAt } : { well: wellFromIndex(runIdx), index: runIdx, source: 'run', at: runAt };
	}
	if (haveRun) return { well: wellFromIndex(runIdx), index: runIdx, source: 'run', at: runAt };
	if (haveCur) return { well: wellFromIndex(curIdx), index: curIdx, source: 'studio', at: curAt };
	return { well: 'A1', index: 0, source: 'default', at: null };
}

/** After a successful Studio pick-up from `well`: the next fresh tip is the one after it. */
export async function recordStudioTipPickup(robotId: string, profile: TipProfile, well: string): Promise<string> {
	await connectDB();
	const i = indexFromWell(well);
	const next = i == null ? 0 : (i + 1) % 96;
	// A hand-set next tip stays hand-set through Studio pick-ups: they walk on from it.
	const prev = (await OpentronsRobot.findById(robotId).select('studioTip').lean()) as any;
	const manual = prev?.studioTip?.[profile]?.manual === true;
	await OpentronsRobot.updateOne({ _id: robotId }, { $set: { [`studioTip.${profile}`]: { index: next, at: new Date(), lastWell: well, ...(manual ? { manual: true } : {}) } } });
	return wellFromIndex(next);
}

/**
 * The operator points the rack at its next fresh tip by hand (Run tab, 2026-11-19).
 * The next run that declares bims_tip_exact starts EXACTLY there (even behind the
 * robot's own tracker, e.g. after swapping in a part-used rack); then clearManualTip.
 */
export async function setManualNextTip(robotId: string, profile: TipProfile, well: string, username: string | null): Promise<{ well: string; index: number }> {
	await connectDB();
	const i = indexFromWell(well);
	if (i == null) throw new Error(`"${well}" is not a tip position (A1 to H12).`);
	await OpentronsRobot.updateOne(
		{ _id: robotId },
		{ $set: { [`studioTip.${profile}`]: { index: i, at: new Date(), lastWell: null, manual: true, setBy: username ?? null } } }
	);
	return { well: wellFromIndex(i), index: i };
}

/** A run started from the hand-set tip: from here on the usual newest-wins rule applies again. */
export async function clearManualTip(robotId: string, profile: TipProfile): Promise<void> {
	await connectDB();
	await OpentronsRobot.updateOne({ _id: robotId }, { $unset: { [`studioTip.${profile}.manual`]: '' } });
}
