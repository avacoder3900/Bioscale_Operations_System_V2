import { fail } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, Spu, ValidationSession, CartridgeGroup, AuditLog, generateId } from '$lib/server/db';
import { cycleSummary, inCurrentCycle, VALIDATION_INSTRUMENTS } from '$lib/server/spu-validation-cycle';
import { isLegalTransition } from '$lib/server/spu-status';
import { syncServiceFlag } from '$lib/server/service-flag';
import { appendSpuJournal } from '$lib/server/spu-journal';
import { syncOpticsValidation } from '$lib/server/services/optics-validation-sync';
import type { Actions, PageServerLoad } from './$types';

/**
 * SPU Validation hub (SPU-INV-11; instruments re-cut 2026-10-13): the unified
 * fleet view. Each instrument keeps its own execution page — this page answers
 * "where does the fleet stand" with real measurements per unit:
 *   Screen        pass / fail / warn counts of the latest screen (firmware v102)
 *   Magnetometer  gauss at every point (fixed-position read) + min sweep gradient
 *   Thermocouple  mode temperature of the heat-cart hold
 *   Assay run     latest group's bead index per lane and CV
 * Optics (spectrophotometer) is no longer a gate; its legacy rollup is shown
 * only as a note on units that still carry one.
 */
export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	const [spus, latestMagSessions, latestSweeps, latestScreens, latestGroups] = await Promise.all([
		Spu.find({ status: { $ne: 'retired' } })
			.select('udi status validation validationResetAt')
			.sort({ udi: 1 })
			.lean(),
		// Latest mag session per unit — fallback gauss source for units whose
		// rollup predates the fail-rollup fix (sessions always have the wells).
		ValidationSession.aggregate([
			{ $match: { type: { $in: ['mag', 'magnetometer'] } } },
			{ $sort: { startedAt: -1 } },
			{ $group: { _id: '$spuId', magResults: { $first: '$magResults' }, overallPassed: { $first: '$overallPassed' }, at: { $first: '$startedAt' } } }
		]),
		ValidationSession.aggregate([
			{ $match: { type: 'mag_sweep' } },
			{ $sort: { startedAt: -1 } },
			{ $group: { _id: '$spuId', minGradient: { $first: '$magResults.minGradient' }, at: { $first: '$startedAt' }, sessionId: { $first: '$_id' } } }
		]),
		ValidationSession.aggregate([
			{ $match: { type: 'screen' } },
			{ $sort: { startedAt: -1 } },
			{ $group: { _id: '$spuId', sessionId: { $first: '$_id' }, status: { $first: '$status' }, overallPassed: { $first: '$overallPassed' }, at: { $first: '$startedAt' }, summary: { $first: '$rawData.summary' } } }
		]),
		CartridgeGroup.aggregate([
			{ $match: { purpose: 'assay_run', archivedAt: null } },
			{ $sort: { createdAt: -1 } },
			{ $group: { _id: '$spuId', groupId: { $first: '$_id' }, name: { $first: '$name' }, evaluation: { $first: '$evaluation' }, at: { $first: '$evaluatedAt' } } }
		])
	]);

	const magBySpu = new Map<string, any>(latestMagSessions.map((m: any) => [m._id, m]));
	const sweepBySpu = new Map<string, any>(latestSweeps.map((m: any) => [m._id, m]));
	const screenBySpu = new Map<string, any>(latestScreens.map((m: any) => [m._id, m]));
	const groupBySpu = new Map<string, any>(latestGroups.map((m: any) => [m._id, m]));

	// The mag wells grid: [{well, A, B, C}] of Z (gauss) values.
	function magWells(raw: any): { well: number; A: number | null; B: number | null; C: number | null }[] | null {
		if (!Array.isArray(raw) || raw.length === 0) return null;
		return raw.map((w: any) => ({
			well: w.well ?? 0,
			A: w.chA_Z ?? null,
			B: w.chB_Z ?? null,
			C: w.chC_Z ?? null
		}));
	}
	function zRange(wells: ReturnType<typeof magWells>): string | null {
		if (!wells) return null;
		const zs = wells.flatMap((w) => [w.A, w.B, w.C]).filter((z): z is number => z != null);
		if (!zs.length) return null;
		return `${Math.min(...zs)}–${Math.max(...zs)}`;
	}

	const rows = (spus as any[]).map((s) => {
		const v = s.validation ?? {};
		// Only the current validation cycle counts (spu-validation-cycle.ts):
		// a rollup from before the unit last entered servicing reads as pending,
		// and its measurements are not shown as if they were current.
		const cycle = cycleSummary(s);
		const current = (rollup: any) => inCurrentCycle(rollup?.completedAt, s.validationResetAt);

		const magRollupWells = current(v.magnetometer) ? magWells(v.magnetometer?.results) : null;
		const rawMagSession = magBySpu.get(s._id);
		const magSession = rawMagSession && inCurrentCycle(rawMagSession.at, s.validationResetAt) ? rawMagSession : null;
		const wells = magRollupWells ?? magWells(magSession?.magResults);
		const sweep = sweepBySpu.get(s._id);
		const sweepCurrent = sweep && inCurrentCycle(sweep.at, s.validationResetAt) ? sweep : null;

		const sc = current(v.screen) ? (v.screen ?? {}) : {};
		const screenSession = screenBySpu.get(s._id);
		const screenLive = screenSession && inCurrentCycle(screenSession.at, s.validationResetAt) ? screenSession : null;

		const th = current(v.thermocouple) ? (v.thermocouple ?? {}) : {};
		const thermoMode =
			th.results?.stats?.mode ?? th.results?.mode ?? th.results?.overallStats?.mode ?? null;

		const ar = current(v.assay_run) ? (v.assay_run ?? {}) : {};
		const group = groupBySpu.get(s._id);
		const groupLive = group && inCurrentCycle(group.at, s.validationResetAt) ? group : null;
		const arResults = ar.results ?? groupLive?.evaluation ?? null;

		const opt = v.spectrophotometer ?? {};
		const overall = cycle.overall;

		// Most recent test of ANY modality — drives the default sort.
		const times = [
			sc.completedAt,
			screenLive?.at,
			v.magnetometer?.completedAt,
			v.magnetometer?.testRanAt,
			magSession?.at,
			sweepCurrent?.at,
			th.completedAt,
			ar.completedAt,
			groupLive?.at
		]
			.filter(Boolean)
			.map((t: any) => new Date(t).getTime());
		const lastTestAt = times.length ? new Date(Math.max(...times)) : null;

		return {
			lastTestAt,
			id: s._id,
			udi: s.udi,
			status: s.status ?? 'draft',
			passedCount: cycle.passed,
			total: cycle.total,
			// Passing validation qualifies validating → released; release itself
			// is the manual act (the button in the last column).
			canRelease: (s.status ?? 'draft') === 'validating' && overall === 'passed',
			screen: {
				status: cycle.statuses.screen,
				counts: sc.results?.counts ?? null,
				sessionId: sc.sessionId ?? screenLive?.sessionId ?? null,
				running: !!screenLive && screenLive.status === 'running',
				fw: sc.rawData?.fw ?? null,
				failureReasons: sc.failureReasons ?? []
			},
			mag: {
				status: cycle.statuses.magnetometer,
				wells,
				zRange: zRange(wells),
				failureReasons: v.magnetometer?.failureReasons ?? [],
				fromSession: !magRollupWells && !!magSession,
				minGradient: sweepCurrent?.minGradient ?? null,
				sweepSessionId: sweepCurrent?.sessionId ?? null
			},
			thermo: {
				status: cycle.statuses.thermocouple,
				mode: thermoMode,
				sessionId: th.sessionId ?? null
			},
			assayRun: {
				status: cycle.statuses.assay_run,
				groupId: ar.groupId ?? groupLive?.groupId ?? null,
				groupName: groupLive?.name ?? ar.rawData?.groupName ?? null,
				beadIndex: arResults
					? { A: arResults.lanes?.A?.beadIndexMean ?? null, B: arResults.lanes?.B?.beadIndexMean ?? null, C: arResults.lanes?.C?.beadIndexMean ?? null }
					: null,
				beadIndexCv: arResults?.beadIndexCv ?? null,
				nValid: arResults?.nValid ?? null,
				n: arResults?.n ?? null,
				stageMaxErr: arResults?.stage?.maxAbsErrorUm ?? null,
				failureReasons: ar.failureReasons ?? []
			},
			legacyOptics: {
				status: cycle.legacy.spectrophotometer,
				ratios: opt.results?.ratioByChannel ?? null,
				cartridgeBarcode: opt.results?.cartridgeBarcode ?? null
			}
		};
	});

	// Most recently tested first; never-tested units sink to the bottom.
	rows.sort((a, b) => (b.lastTestAt?.getTime() ?? 0) - (a.lastTestAt?.getTime() ?? 0));

	return { rows: JSON.parse(JSON.stringify(rows)), instruments: [...VALIDATION_INSTRUMENTS] };
};

export const actions: Actions = {
	/**
	 * Legacy optics → SPU write-back. Retired from the gate on 2026-10-13 (the
	 * assay run replaced optical confirmation); kept callable for the R&D pages
	 * and for history. Writes only the legacy `validation.spectrophotometer`
	 * slot, which no longer counts toward release.
	 */
	syncOptics: async ({ locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const r = await syncOpticsValidation();
		await AuditLog.create({
			_id: generateId(),
			tableName: 'spus',
			recordId: 'fleet',
			action: 'UPDATE',
			newData: { opticsSync: { updated: r.updated, unchanged: r.unchanged.length, noReadings: r.skippedNoReadings.length } },
			reason: 'Manual (legacy) optics → SPU sync from the validation hub',
			changedBy: locals.user!.username ?? locals.user!._id,
			changedAt: new Date()
		});
		return {
			opticsSynced: true,
			updated: r.updated.length,
			unchanged: r.unchanged.length,
			noReadings: r.skippedNoReadings.length,
			passed: r.updated.filter((u) => u.status === 'passed').length,
			failed: r.updated.filter((u) => u.status === 'failed').length
		};
	},

	/**
	 * Release a unit from the hub. Passing every instrument in the current
	 * cycle is what qualifies a validating unit; pressing Release is the manual
	 * act that moves it (SPU-INV-07 doctrine).
	 */
	release: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();

		const form = await request.formData();
		const spuId = form.get('spuId')?.toString() ?? '';
		if (!spuId) return fail(400, { error: 'Missing SPU' });

		const spu = (await Spu.findById(spuId)
			.select('udi status finalizedAt validation validationResetAt')
			.lean()) as any;
		if (!spu) return fail(404, { error: 'SPU not found' });
		if (spu.finalizedAt) return fail(400, { error: `${spu.udi} is finalized and cannot be modified` });

		const from = spu.status ?? 'draft';
		if (!isLegalTransition(from, 'released')) {
			return fail(400, { error: `${spu.udi} is ${from} — only a validating unit can be released` });
		}
		const cycle = cycleSummary(spu);
		if (cycle.overall !== 'passed') {
			return fail(400, {
				error: `${spu.udi} has ${cycle.passed}/${cycle.total} validations passed this cycle — all ${cycle.total} must pass before release`
			});
		}

		const who = { _id: locals.user!._id, username: locals.user!.username };
		const now = new Date();
		const reason = `Released from the validation hub — ${cycle.total}/${cycle.total} validations passed this cycle`;
		await Spu.updateOne(
			{ _id: spuId, status: from },
			{
				$set: { status: 'released' },
				$push: {
					statusTransitions: { _id: generateId(), from, to: 'released', changedBy: who, changedAt: now, reason }
				}
			}
		);
		await AuditLog.create({
			_id: generateId(),
			tableName: 'spus',
			recordId: spuId,
			action: 'UPDATE',
			oldData: { status: from },
			newData: { status: 'released' },
			reason,
			changedBy: who.username ?? who._id,
			changedAt: now
		});
		await appendSpuJournal(
			spuId,
			'Released — screen, magnetometer, thermocouple and assay run all passed this validation cycle.',
			who,
			{ source: 'release' }
		);
		// Yellow-LED service flag off (SPU-INV-08) — best-effort, never blocks.
		const serviceFlag = await syncServiceFlag(spuId);

		return { released: true, udi: spu.udi, serviceFlag: serviceFlag.state };
	}
};

export const config = { maxDuration: 60 };
