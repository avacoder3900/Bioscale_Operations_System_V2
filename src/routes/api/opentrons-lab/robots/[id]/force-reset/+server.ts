/**
 * Force a robot back to IDLE from the Run Wizard — master reset for stale/stuck runs.
 * POST /api/opentrons-lab/robots/:id/force-reset
 *
 * "In any circumstance": (1) abort any BIMS run record that's page-owning the robot
 * (wax → 'aborted', reagent → 'Cancelled') so the wizard frees it, AND (2) best-effort
 * stop + delete the robot's own current protocol run + any stale maintenance run via
 * the (bridge-aware) robot API. Cartridges are left as-is. Any authenticated
 * manufacturing user can run it (with a confirm in the UI).
 */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, WaxFillingRun, ReagentBatchRecord, AuditLog, generateId } from '$lib/server/db';
import { getRobot, robotGet, robotPost, robotDelete } from '$lib/server/opentrons/proxy';

export const config = { maxDuration: 60 };

// A robot is "locked" in the Run Wizard while a run sits in one of these statuses.
const WAX_PAGE_OWNED = ['Setup', 'Loading', 'Running', 'Awaiting Removal', 'Cooling', 'QC', 'Storage'];
const REAGENT_PAGE_OWNED = ['Setup', 'Loading', 'Running', 'Inspection'];

export const POST: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:write');

	const robot = await getRobot(params.id);
	if (!robot) error(404, 'Robot not found');
	const robotId = String((robot as any)._id);
	const now = new Date();

	await connectDB();

	// 1) Abort the BIMS-side stuck runs that lock the robot (this is what frees the
	//    wizard — it's purely status-driven). Leave cartridges untouched.
	const waxRes = await WaxFillingRun.updateMany(
		{ 'robot._id': robotId, status: { $in: WAX_PAGE_OWNED } },
		{ $set: { status: 'aborted', abortReason: 'force reset to idle', runEndTime: now, robotReleasedAt: now } }
	);
	const reaRes = await ReagentBatchRecord.updateMany(
		{ 'robot._id': robotId, status: { $in: REAGENT_PAGE_OWNED } },
		{ $set: { status: 'Cancelled', abortReason: 'force reset to idle', runEndTime: now, robotReleasedAt: now } }
	);

	// 2) Best-effort: clear the robot's own run state (stop + delete current
	//    protocol run, drop any stale maintenance run). Never fail the reset on
	//    this — the BIMS abort above is what actually frees the wizard.
	const robotActions: string[] = [];
	try {
		const runsRes = await robotGet(robot as any, '/runs');
		if (runsRes.ok) {
			const body = await runsRes.json().catch(() => ({}) as any);
			const currentHref = (body?.links?.current?.href ?? '') as string;
			const currentId = currentHref ? currentHref.split('/').pop() : null;
			if (currentId) {
				// stop is a no-op if already terminal; delete clears it from /runs.
				await robotPost(robot as any, `/runs/${currentId}/actions`, { data: { actionType: 'stop' } }).catch(() => {});
				await robotDelete(robot as any, `/runs/${currentId}`).catch(() => {});
				robotActions.push(`stopped+deleted run ${currentId.slice(0, 8)}`);
			}
		}
		// Stale maintenance run (blocks future maintenance ops).
		const mr = await robotGet(robot as any, '/maintenance_runs/current').catch(() => null);
		if (mr && mr.ok) {
			const mb = await mr.json().catch(() => ({}) as any);
			const mid = mb?.data?.id;
			if (mid) {
				await robotDelete(robot as any, `/maintenance_runs/${mid}`).catch(() => {});
				robotActions.push(`cleared maintenance run ${String(mid).slice(0, 8)}`);
			}
		}
	} catch (e) {
		robotActions.push(`robot unreachable (${e instanceof Error ? e.message : 'error'}) — BIMS records still cleared`);
	}

	await AuditLog.create({
		_id: generateId(),
		tableName: 'opentrons_robots',
		recordId: robotId,
		action: 'force_reset_to_idle',
		newData: { abortedWaxRuns: waxRes.modifiedCount, cancelledReagentRuns: reaRes.modifiedCount, robotActions },
		changedAt: now,
		changedBy: locals.user.username
	});

	const cleared = waxRes.modifiedCount + reaRes.modifiedCount;
	const message =
		cleared > 0
			? `Reset to idle — aborted ${waxRes.modifiedCount} wax + ${reaRes.modifiedCount} reagent run(s).${robotActions.length ? ' ' + robotActions.join('; ') + '.' : ''}`
			: `No active BIMS run to abort.${robotActions.length ? ' ' + robotActions.join('; ') + '.' : ' Robot was already idle.'}`;

	return json({ ok: true, message, abortedWaxRuns: waxRes.modifiedCount, cancelledReagentRuns: reaRes.modifiedCount, robotActions });
};
