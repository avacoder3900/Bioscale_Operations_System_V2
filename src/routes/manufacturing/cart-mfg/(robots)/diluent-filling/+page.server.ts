/**
 * Diluent filling SETUP page + actions (DILUENT-FILL-1, 2026-11-13).
 *
 * Setup (pipette, three source tubes: reagent lot / tubes / mL loaded) → Load
 * deck (checklist, confirm) → Start → Running → Completed, for ONE robot
 * (?robot=<id>). The wizard also renders in the robot's panel on /robots and
 * posts to the actions here explicitly (see DiluentWizard's `act`). The run
 * lifecycle (start / finish / cancel / abort, queue and tailnet lines) is the
 * shared machinery in $lib/server/opentrons/run-lifecycle-records with kind
 * 'diluent'.
 */
import { redirect, fail } from '@sveltejs/kit';
import { connectDB, DiluentFillRun, ReagentLot, AuditLog, generateId } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import { checkRobotConflict } from '$lib/server/manufacturing/resource-locks';
import { loadDiluentWizard } from '$lib/server/manufacturing/diluent-wizard';
import {
	finalizeDiluentRun,
	startRunQueue,
	recordRunFinishedQueue,
	stopRunQueue,
	lifecycleActions,
	isActionFail
} from '$lib/server/opentrons/run-lifecycle-records';
import {
	DILUENT_SOURCE_WELLS,
	DILUENT_PIPETTES,
	diluentTubesPerTrip,
	validateDiluentSetup,
	isDiluentPipette,
	UNTRACKED_LOT_ID
} from '$lib/manufacturing/diluent-fill';
import type { PageServerLoad, Actions } from './$types';

export const config = { maxDuration: 60 };

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'diluentFilling:read');
	const robot = url.searchParams.get('robot');
	if (!robot) redirect(302, '/manufacturing/cart-mfg/robots');
	return loadDiluentWizard(locals, robot);
};

type Ev = { request: Request; locals: App.Locals; url: URL };
async function begin({ request, locals }: Ev) {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'diluentFilling:write');
	await connectDB();
	return { form: await request.formData(), user: { _id: locals.user._id, username: locals.user.username } };
}
const num = (v: FormDataEntryValue | null, fallback = 0): number => {
	const n = parseFloat(String(v ?? ''));
	return Number.isFinite(n) ? n : fallback;
};

export const actions: Actions = {
	/** Open a run for this robot (stage Setup). */
	createRun: async (ev) => {
		const { form, user } = await begin(ev);
		const robotId = (form.get('robotId') as string) ?? ev.url.searchParams.get('robot') ?? '';
		const robotName = (form.get('robotName') as string) || robotId;
		if (!robotId) return fail(400, { error: 'robotId is required' });
		const conflict = await checkRobotConflict(robotId);
		if (conflict) return fail(400, { error: conflict });
		const run = await DiluentFillRun.create({
			robot: { _id: robotId, name: robotName },
			operator: user,
			status: 'Setup',
			pipette: 'p1000',
			diluentVolumeUl: 104.5,
			tubesPerTrip: DILUENT_PIPETTES.p1000.maxTubesPerTrip,
			sources: DILUENT_SOURCE_WELLS.map((well) => ({ well, tubesPlanned: 0, loadedMl: 0 })),
			setupTimestamp: new Date()
		});
		await AuditLog.create({ _id: generateId(), tableName: 'diluent_fill_runs', recordId: String(run._id), action: 'INSERT', changedBy: user.username, changedAt: new Date() });
		return { success: true, runId: String(run._id) };
	},

	/** Save the setup (pipette, volume, sources) and move to Loading. */
	saveSetup: async (ev) => {
		const { form, user } = await begin(ev);
		const runId = (form.get('runId') as string) ?? '';
		const run = (await DiluentFillRun.findById(runId).lean()) as any;
		if (!run) return fail(404, { error: 'Diluent run not found' });
		if (!['Setup', 'Loading'].includes(run.status)) return fail(400, { error: `Setup can no longer be changed (run is ${run.status}).` });

		const pipette = form.get('pipette');
		if (!isDiluentPipette(pipette)) return fail(400, { error: 'Pick a pipette.' });
		const diluentVolumeUl = num(form.get('volumeUl'), 0);
		const tubesPerTrip = diluentTubesPerTrip(pipette, num(form.get('tubesPerTrip'), DILUENT_PIPETTES[pipette].maxTubesPerTrip), diluentVolumeUl || 1);

		const lotIds = DILUENT_SOURCE_WELLS.map((_, i) => String(form.get(`src_${i + 1}_lot`) ?? '').trim()).filter((id) => id && id !== UNTRACKED_LOT_ID);
		const lots = lotIds.length
			? ((await ReagentLot.find({ _id: { $in: lotIds }, status: 'finalized' }).select('_id lotBarcode templateName').lean()) as any[])
			: [];
		const sources = DILUENT_SOURCE_WELLS.map((well, i) => {
			const lotId = String(form.get(`src_${i + 1}_lot`) ?? '').trim();
			if (lotId === UNTRACKED_LOT_ID) {
				// Placeholder source (2026-11-13): the diluent stock is not a tracked lot yet.
				const label = String(form.get(`src_${i + 1}_lot_label`) ?? '').trim().slice(0, 80);
				return {
					well,
					reagentLotId: UNTRACKED_LOT_ID,
					reagentLotBarcode: label || 'untracked diluent',
					templateName: null,
					tubesPlanned: Math.max(0, Math.floor(num(form.get(`src_${i + 1}_tubes`), 0))),
					loadedMl: Math.max(0, Math.round(num(form.get(`src_${i + 1}_ml`), 0) * 100) / 100)
				};
			}
			const lot = lots.find((l) => String(l._id) === lotId);
			return {
				well,
				reagentLotId: lot ? String(lot._id) : null,
				reagentLotBarcode: lot?.lotBarcode ?? null,
				templateName: lot?.templateName ?? null,
				tubesPlanned: Math.max(0, Math.floor(num(form.get(`src_${i + 1}_tubes`), 0))),
				loadedMl: Math.max(0, Math.round(num(form.get(`src_${i + 1}_ml`), 0) * 100) / 100)
			};
		});
		for (let i = 0; i < sources.length; i++) {
			const posted = String(form.get(`src_${i + 1}_lot`) ?? '').trim();
			if (posted && !sources[i].reagentLotId) return fail(400, { error: `Source ${sources[i].well}: that reagent lot is not a finalized BIMS lot.` });
		}

		const problems = validateDiluentSetup({ pipette, diluentVolumeUl, tubesPerTrip, sources });
		if (problems.length) return fail(400, { error: problems.join(' ') });

		await DiluentFillRun.updateOne(
			{ _id: runId },
			{ $set: { pipette, diluentVolumeUl, tubesPerTrip, sources, status: 'Loading' }, $unset: { deckConfirmedAt: '' } }
		);
		await AuditLog.create({
			_id: generateId(), tableName: 'diluent_fill_runs', recordId: runId, action: 'UPDATE', changedBy: user.username, changedAt: new Date(),
			newData: { status: 'Loading', pipette, diluentVolumeUl, tubesPerTrip, sources }
		});
		return { success: true };
	},

	/** Back from Loading to Setup (nothing has run yet). */
	backToSetup: async (ev) => {
		const { form } = await begin(ev);
		const runId = (form.get('runId') as string) ?? '';
		const r = await DiluentFillRun.updateOne({ _id: runId, status: 'Loading' }, { $set: { status: 'Setup' }, $unset: { deckConfirmedAt: '' } });
		if (!r.matchedCount) return fail(400, { error: 'Only a run in Loading can go back to Setup.' });
		return { success: true };
	},

	/** The operator confirms the deck matches the setup; the Start panel appears. */
	confirmDeck: async (ev) => {
		const { form, user } = await begin(ev);
		const runId = (form.get('runId') as string) ?? '';
		const r = await DiluentFillRun.updateOne({ _id: runId, status: 'Loading' }, { $set: { deckConfirmedAt: new Date() } });
		if (!r.matchedCount) return fail(400, { error: 'Only a run in Loading can confirm its deck.' });
		await AuditLog.create({ _id: generateId(), tableName: 'diluent_fill_runs', recordId: runId, action: 'UPDATE', changedBy: user.username, changedAt: new Date(), newData: { deckConfirmed: true } });
		return { success: true };
	},

	/** Start the run — the queue line's single action (prepare → robot → confirm). */
	startRun: async (ev) => {
		const { form, user } = await begin(ev);
		const r = await startRunQueue('diluent', form, user);
		if (isActionFail(r)) return fail(r.fail.status, { error: r.fail.error });
		return r;
	},

	/** The embedded controller saw a terminal status: record it (a succeeded run auto-finalizes). */
	recordRunFinished: async (ev) => {
		const { form, user } = await begin(ev);
		const runId = (form.get('runId') as string) ?? '';
		const finalStatus = (form.get('finalStatus')?.toString() ?? '').toLowerCase();
		const r = await recordRunFinishedQueue('diluent', runId, finalStatus, user);
		if (isActionFail(r)) return fail(r.fail.status, { error: r.fail.error });
		return r;
	},

	/**
	 * Complete a run that did not finish `succeeded` (stopped / failed): the
	 * operator enters how many tubes each source actually got. Idempotent for
	 * runs the auto-finalize already closed.
	 */
	completeRun: async (ev) => {
		const { form, user } = await begin(ev);
		const runId = (form.get('runId') as string) ?? '';
		const run = (await DiluentFillRun.findById(runId).select('status opentronsRunFinalStatus sources').lean()) as any;
		if (!run) return fail(404, { error: 'Diluent run not found' });
		if (run.status === 'Completed') return { success: true, lotNumber: run.diluentLotNumber ?? null };
		const finalStatus = String(run.opentronsRunFinalStatus ?? '').toLowerCase();
		if (!finalStatus) return fail(400, { error: 'The robot has not finished this run yet.' });
		const acknowledged = form.get('confirmDespiteFailure')?.toString() === 'true';
		if (finalStatus !== 'succeeded' && !acknowledged) {
			return fail(400, { error: `This run ended in "${finalStatus}". Enter the tubes actually filled per source and confirm.`, requiresFailureAck: true });
		}
		const tubesFilled: Record<string, number> = {};
		for (const well of DILUENT_SOURCE_WELLS) {
			const v = form.get(`filled_${well}`);
			if (v != null && v !== '') tubesFilled[well] = Math.max(0, Math.floor(num(v, 0)));
		}
		const res = await finalizeDiluentRun(runId, user, 'manual Complete', { tubesFilled: finalStatus === 'succeeded' ? {} : tubesFilled });
		if ('notFound' in res) return fail(404, { error: 'Run not found' });
		return { success: true, lotNumber: res.lotNumber };
	},

	cancelRun: async (ev) => {
		const { form, user } = await begin(ev);
		const runId = (form.get('runId') as string) ?? '';
		const reason = (form.get('reason') as string) || 'Cancelled by operator';
		const r = await stopRunQueue('diluent', 'cancel', runId, { reason }, user);
		if (isActionFail(r)) return fail(r.fail.status, { error: r.fail.error });
		return r;
	},

	abortRun: async (ev) => {
		const { form, user } = await begin(ev);
		const runId = (form.get('runId') as string) ?? '';
		const reason = (form.get('reason') as string) || 'Aborted';
		const photoUrl = (form.get('photoUrl') as string) || undefined;
		const r = await stopRunQueue('diluent', 'abort', runId, { reason, photoUrl }, user);
		if (isActionFail(r)) return fail(r.fail.status, { error: r.fail.error });
		return r;
	},

	// Two-phase lifecycle (tailnet line): startPrepare … abortConfirm.
	...lifecycleActions('diluent')
};
