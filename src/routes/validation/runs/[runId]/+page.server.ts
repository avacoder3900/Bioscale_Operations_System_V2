import { error, fail } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import {
	connectDB, Spu, ValidationRun, ValidationSession, AuditLog, generateId
} from '$lib/server/db';
import { STANDARD_THERMO_CRITERIA } from '$lib/server/validation/thermo-criteria';
import { processThermoUpload, evaluateThermoSession, type ThermoReading } from '$lib/server/validation/thermo-upload';
import type { Actions, PageServerLoad } from './$types';

const MANUAL_OUTCOMES = ['passed', 'failed', 'skipped'] as const;

async function loadRun(runId: string): Promise<any> {
	const run = await ValidationRun.findById(runId).lean() as any;
	if (!run) throw error(404, 'Validation run not found');
	return run;
}

function requireInProgress(run: any) {
	if (run.status !== 'in_progress') {
		return fail(400, { error: `Run is ${run.status} and can no longer be modified` });
	}
	return null;
}

function activeMember(run: any, spuId: string): any | null {
	return (run.spus ?? []).find((m: any) => m.spuId === spuId && !m.removedAt) ?? null;
}

async function auditRun(runId: string, action: string, username: string, newData: Record<string, unknown>, oldData?: Record<string, unknown>) {
	await AuditLog.create({
		_id: generateId(),
		tableName: 'validation_runs',
		recordId: runId,
		action,
		oldData: oldData ?? null,
		newData,
		changedAt: new Date(),
		changedBy: username
	});
}

export const load: PageServerLoad = async ({ locals, params }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	const run = await loadRun(params.runId);

	// Linked sessions — metadata + stats only, never the raw readings arrays.
	// Includes sessions from earlier attempts (`previous`) so history links work.
	const sessionIds = (run.spus ?? [])
		.flatMap((m: any) => Object.values(m.steps ?? {}).flatMap((c: any) => [
			c?.sessionId,
			...(c?.previous ?? []).map((p: any) => p?.sessionId)
		]))
		.filter(Boolean);
	const sessions = sessionIds.length
		? await ValidationSession.find({ _id: { $in: sessionIds } })
			.select('-results.rawData -rawData -magResults')
			.lean() as any[]
		: [];
	const sessionById: Record<string, any> = {};
	for (const s of sessions) {
		sessionById[s._id] = {
			id: s._id,
			type: s.type,
			status: s.status,
			barcode: s.barcode ?? null,
			completedAt: s.completedAt?.toISOString?.() ?? null
		};
	}

	// Current SPU rollup statuses (live view alongside the run's own cells).
	// Prior validation results (spu.validation.{magnetometer,thermocouple} —
	// written by the instrument pages, possibly before this run existed) are
	// surfaced per step so a previously-passed mag test is visible in the
	// matrix and can be adopted into the run.
	const memberIds = (run.spus ?? []).map((m: any) => m.spuId);
	const spus = memberIds.length
		? await Spu.find({ _id: { $in: memberIds } })
			.select('udi status finalizedAt validation.status validation.magnetometer validation.thermocouple')
			.lean() as any[]
		: [];
	const spuById: Record<string, any> = {};
	for (const s of spus) {
		const priorOf = (v: any) => v?.status && v.status !== 'pending'
			? {
				status: v.status,
				sessionId: v.sessionId ?? null,
				completedAt: v.completedAt?.toISOString?.() ?? v.completedAt ?? null,
				failureReasons: v.failureReasons ?? []
			}
			: null;
		spuById[s._id] = {
			id: s._id,
			udi: s.udi,
			status: s.status,
			finalized: !!s.finalizedAt,
			validationStatus: s.validation?.status ?? 'pending',
			magStatus: s.validation?.magnetometer?.status ?? 'pending',
			thermoStatus: s.validation?.thermocouple?.status ?? 'pending',
			prior: {
				magnetometer: priorOf(s.validation?.magnetometer),
				thermocouple: priorOf(s.validation?.thermocouple)
			}
		};
	}

	// Pull prior sessions into the session map too, so their links resolve
	const priorSessionIds = Object.values(spuById)
		.flatMap((s: any) => [s.prior.magnetometer?.sessionId, s.prior.thermocouple?.sessionId])
		.filter((id: any) => id && !sessionById[id]);
	if (priorSessionIds.length) {
		const priorSessions = await ValidationSession.find({ _id: { $in: priorSessionIds } })
			.select('-results.rawData -rawData -magResults')
			.lean() as any[];
		for (const s of priorSessions) {
			sessionById[s._id] = {
				id: s._id,
				type: s.type,
				status: s.status,
				barcode: s.barcode ?? null,
				completedAt: s.completedAt?.toISOString?.() ?? null
			};
		}
	}

	return {
		run: JSON.parse(JSON.stringify(run)),
		sessionById,
		spuById,
		thermoCriteria: STANDARD_THERMO_CRITERIA
	};
};

export const actions: Actions = {
	uploadThermo: async ({ request, locals, params }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();

		const run = await loadRun(params.runId);
		const locked = requireInProgress(run);
		if (locked) return locked;

		const form = await request.formData();
		const spuId = form.get('spuId')?.toString();
		const readingsJson = form.get('readings')?.toString();
		const fileName = form.get('fileName')?.toString() || null;

		if (!spuId) return fail(400, { error: 'Missing SPU', spuId });
		const member = activeMember(run, spuId);
		if (!member) return fail(400, { error: 'SPU is not an active member of this run', spuId });
		if (!readingsJson) return fail(400, { error: 'No temperature data uploaded', spuId });

		let readings: ThermoReading[];
		try {
			readings = JSON.parse(readingsJson);
			if (!Array.isArray(readings) || readings.length === 0) {
				return fail(400, { error: 'No valid readings in uploaded data', spuId });
			}
		} catch {
			return fail(400, { error: 'Invalid readings data', spuId });
		}

		const user = { _id: locals.user!._id, username: locals.user!.username };
		const outcome = await processThermoUpload({
			spuId,
			readings,
			criteria: STANDARD_THERMO_CRITERIA,
			runId: params.runId,
			fileName,
			user
		});
		if ('error' in outcome) return fail(400, { error: outcome.error, spuId });

		// Decision 2: uploaded ≠ passed. Without a configured standard range the
		// cell parks at 'uploaded'; with one, evaluation ran inside the upload.
		// A re-upload keeps the earlier attempt in `previous` so failed history
		// stays visible after a retry.
		const prior = member.steps?.thermocouple;
		const previous = [
			...(prior?.previous ?? []),
			...(prior?.sessionId
				? [{
					status: prior.status,
					sessionId: prior.sessionId,
					result: prior.result ?? null,
					evaluation: prior.evaluation ?? null,
					completedAt: prior.completedAt ?? null,
					completedBy: prior.completedBy ?? null
				}]
				: [])
		];
		const now = new Date();
		const cell: Record<string, unknown> = {
			previous,
			status: outcome.evaluated ? (outcome.passed ? 'passed' : 'failed') : 'uploaded',
			sessionId: outcome.sessionId,
			result: { ...outcome.stats, fileName },
			completedAt: outcome.evaluated ? now : null,
			completedBy: user,
			evaluation: outcome.evaluated && STANDARD_THERMO_CRITERIA
				? {
					criteria: STANDARD_THERMO_CRITERIA,
					passed: outcome.passed,
					failureReasons: outcome.failureReasons,
					evaluatedAt: now,
					evaluatedBy: user
				}
				: null
		};
		await ValidationRun.updateOne(
			{ _id: params.runId, 'spus.spuId': spuId },
			{ $set: { 'spus.$.steps.thermocouple': cell } }
		);

		await auditRun(params.runId, 'validation_run_thermo_uploaded', user.username, {
			spuId,
			spuUdi: member.udi,
			sessionId: outcome.sessionId,
			fileName,
			readingCount: outcome.stats.readingCount,
			evaluated: outcome.evaluated,
			passed: outcome.passed
		});

		return {
			success: true,
			spuId,
			uploaded: true,
			evaluated: outcome.evaluated,
			passed: outcome.passed
		};
	},

	evaluateThermo: async ({ request, locals, params }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();

		if (!STANDARD_THERMO_CRITERIA) {
			return fail(400, { error: 'Standard thermocouple acceptance range is not configured yet' });
		}

		const run = await loadRun(params.runId);
		const locked = requireInProgress(run);
		if (locked) return locked;

		const form = await request.formData();
		const spuId = form.get('spuId')?.toString();
		if (!spuId) return fail(400, { error: 'Missing SPU' });
		const member = activeMember(run, spuId);
		if (!member) return fail(400, { error: 'SPU is not an active member of this run', spuId });
		const cell = member.steps?.thermocouple;
		if (!cell?.sessionId) return fail(400, { error: 'No uploaded thermocouple data to evaluate', spuId });

		const user = { _id: locals.user!._id, username: locals.user!.username };
		const outcome = await evaluateThermoSession({
			sessionId: cell.sessionId,
			criteria: STANDARD_THERMO_CRITERIA,
			user
		});
		if ('error' in outcome) return fail(400, { error: outcome.error, spuId });

		const now = new Date();
		await ValidationRun.updateOne(
			{ _id: params.runId, 'spus.spuId': spuId },
			{
				$set: {
					'spus.$.steps.thermocouple.status': outcome.passed ? 'passed' : 'failed',
					'spus.$.steps.thermocouple.completedAt': now,
					'spus.$.steps.thermocouple.completedBy': user,
					'spus.$.steps.thermocouple.evaluation': {
						criteria: outcome.criteria,
						passed: outcome.passed,
						failureReasons: outcome.failureReasons,
						evaluatedAt: now,
						evaluatedBy: user
					}
				}
			}
		);

		await auditRun(params.runId, 'validation_run_thermo_evaluated', user.username, {
			spuId,
			spuUdi: member.udi,
			sessionId: cell.sessionId,
			criteria: outcome.criteria,
			passed: outcome.passed,
			failureReasons: outcome.failureReasons
		}, { previousStatus: cell.status });

		return { success: true, spuId, evaluated: true, passed: outcome.passed };
	},

	recordStepResult: async ({ request, locals, params }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();

		const run = await loadRun(params.runId);
		const locked = requireInProgress(run);
		if (locked) return locked;

		const form = await request.formData();
		const spuId = form.get('spuId')?.toString();
		const step = form.get('step')?.toString();
		const outcome = form.get('outcome')?.toString() as (typeof MANUAL_OUTCOMES)[number] | undefined;
		const notes = form.get('notes')?.toString().trim() || null;
		// Optional: link a ValidationSession (used when adopting a prior result)
		const sessionId = form.get('sessionId')?.toString() || null;

		if (!spuId) return fail(400, { error: 'Missing SPU' });
		const member = activeMember(run, spuId);
		if (!member) return fail(400, { error: 'SPU is not an active member of this run', spuId });
		if (!step || !(run.steps ?? []).includes(step)) return fail(400, { error: 'Unknown step', spuId });
		if (!outcome || !MANUAL_OUTCOMES.includes(outcome)) return fail(400, { error: 'Outcome must be passed, failed, or skipped', spuId });

		const user = { _id: locals.user!._id, username: locals.user!.username };
		const now = new Date();
		const prior = member.steps?.[step];
		const previousStatus = prior?.status ?? 'not_started';
		// Keep the earlier attempt visible when overwriting a decided cell
		const previous = [
			...(prior?.previous ?? []),
			...(prior && !['not_started', 'in_progress'].includes(prior.status)
				? [{
					status: prior.status,
					sessionId: prior.sessionId ?? null,
					result: prior.result ?? null,
					evaluation: prior.evaluation ?? null,
					notes: prior.notes ?? null,
					completedAt: prior.completedAt ?? null,
					completedBy: prior.completedBy ?? null
				}]
				: [])
		];

		// Mirror manual pass/fail into the SPU rollup where one exists
		// (magnetometer/thermocouple; optical confirmation has no rollup field on
		// the Spu model — the run cell is its record). Sacred-gated write first.
		if (outcome !== 'skipped' && (step === 'magnetometer' || step === 'thermocouple')) {
			const spu = await Spu.findById(spuId).select('finalizedAt').lean() as any;
			if (!spu) return fail(400, { error: 'SPU not found', spuId });
			if (spu.finalizedAt) return fail(400, { error: 'SPU is finalized and cannot be modified', spuId });
			await Spu.updateOne(
				{ _id: spuId },
				{
					$set: {
						[`validation.${step}.status`]: outcome,
						[`validation.${step}.completedAt`]: now
					}
				}
			);
		}

		await ValidationRun.updateOne(
			{ _id: params.runId, 'spus.spuId': spuId },
			{
				$set: {
					[`spus.$.steps.${step}.status`]: outcome,
					[`spus.$.steps.${step}.completedAt`]: now,
					[`spus.$.steps.${step}.completedBy`]: user,
					[`spus.$.steps.${step}.notes`]: notes,
					[`spus.$.steps.${step}.previous`]: previous,
					...(sessionId ? { [`spus.$.steps.${step}.sessionId`]: sessionId } : {})
				}
			}
		);

		await auditRun(params.runId, 'validation_run_step_recorded', user.username, {
			spuId,
			spuUdi: member.udi,
			step,
			outcome,
			notes,
			sessionId
		}, { previousStatus });

		return { success: true, spuId, step, outcome };
	},

	removeSpu: async ({ request, locals, params }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();

		const run = await loadRun(params.runId);
		const locked = requireInProgress(run);
		if (locked) return locked;

		const form = await request.formData();
		const spuId = form.get('spuId')?.toString();
		if (!spuId) return fail(400, { error: 'Missing SPU' });
		const member = activeMember(run, spuId);
		if (!member) return fail(400, { error: 'SPU is not an active member of this run', spuId });

		await ValidationRun.updateOne(
			{ _id: params.runId, 'spus.spuId': spuId },
			{ $set: { 'spus.$.removedAt': new Date() } }
		);

		await auditRun(params.runId, 'validation_run_spu_removed', locals.user!.username, {
			spuId,
			spuUdi: member.udi
		});

		return { success: true, spuId };
	},

	// markValidated removed (SPU-INV-07): 'validated' collapsed away and release
	// is a manual validating → released transition on the SPU detail page.

	completeRun: async ({ locals, params }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();

		const run = await loadRun(params.runId);
		const locked = requireInProgress(run);
		if (locked) return locked;

		await ValidationRun.updateOne(
			{ _id: params.runId },
			{ $set: { status: 'completed', completedAt: new Date() } }
		);
		await auditRun(params.runId, 'validation_run_completed', locals.user!.username, {
			runNumber: run.runNumber
		});

		return { success: true, completed: true };
	},

	abortRun: async ({ request, locals, params }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();

		const run = await loadRun(params.runId);
		const locked = requireInProgress(run);
		if (locked) return locked;

		const form = await request.formData();
		const reason = form.get('reason')?.toString().trim();
		if (!reason) return fail(400, { error: 'A reason is required to abort a run' });

		await ValidationRun.updateOne(
			{ _id: params.runId },
			{ $set: { status: 'aborted', completedAt: new Date(), abortReason: reason } }
		);
		await auditRun(params.runId, 'validation_run_aborted', locals.user!.username, {
			runNumber: run.runNumber,
			reason
		});

		return { success: true, aborted: true };
	},

	updateName: async ({ request, locals, params }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();

		const run = await loadRun(params.runId);
		const locked = requireInProgress(run);
		if (locked) return locked;

		const form = await request.formData();
		const name = form.get('name')?.toString().trim() || null;

		await ValidationRun.updateOne({ _id: params.runId }, { $set: { name } });
		await auditRun(params.runId, 'validation_run_renamed', locals.user!.username, { name }, { name: run.name ?? null });

		return { success: true };
	}
};
