import { fail } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, Spu, ValidationSession, AuditLog, generateId } from '$lib/server/db';
import { cycleSummary, inCurrentCycle } from '$lib/server/spu-validation-cycle';
import { isLegalTransition } from '$lib/server/spu-status';
import { syncServiceFlag } from '$lib/server/service-flag';
import { appendSpuJournal } from '$lib/server/spu-journal';
import { loadAutoVerdicts } from '$lib/server/validation-autograde-load';
import type { Actions, PageServerLoad } from './$types';

/**
 * SPU Validation hub (SPU-INV-11): the unified fleet view. Each instrument
 * keeps its own execution page — this page answers "where does the fleet
 * stand" with real measurements: gauss at every point (mag), mode
 * temperature (thermo), and the auto-graded bench + blank checks.
 *
 * Optical confirmation was banked 2026-10-06 (see VALIDATION_INSTRUMENTS):
 * no column, no sync button, and it no longer counts toward release.
 */
export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	const [spus, latestMagSessions] = await Promise.all([
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
		])
	]);

	const magBySpu = new Map<string, any>(latestMagSessions.map((m: any) => [m._id, m]));
	const autoChecks = await loadAutoVerdicts((spus as any[]).map((s) => ({ _id: String(s._id), udi: s.udi ?? null })));
	/** A verdict only counts if its run is in the unit's current cycle. */
	const inCycle = (c: { verdict: string; reasons: string[]; at: string | null } | null, resetAt: unknown) =>
		c && inCurrentCycle(c.at, resetAt as Date | null) ? { verdict: c.verdict, reasons: c.reasons, at: c.at } : null;

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
		const magStatus = cycle.statuses.magnetometer;

		const th = current(v.thermocouple) ? (v.thermocouple ?? {}) : {};
		const thermoMode =
			th.results?.stats?.mode ?? th.results?.mode ?? th.results?.overallStats?.mode ?? null;

		const overall = cycle.overall;
		const auto = autoChecks.get(String(s._id));
		const bench = inCycle(auto?.bench ?? null, s.validationResetAt);
		const blank = inCycle(auto?.blank ?? null, s.validationResetAt);

		// Most recent test of ANY modality — drives the default sort.
		const times = [
			v.magnetometer?.completedAt,
			v.magnetometer?.testRanAt,
			magSession?.at,
			th.completedAt,
			auto?.bench?.at,
			auto?.blank?.at
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
			mag: {
				status: magStatus,
				wells,
				zRange: zRange(wells),
				failureReasons: v.magnetometer?.failureReasons ?? [],
				fromSession: !magRollupWells && !!magSession
			},
			bench,
			blank,
			thermo: {
				status: cycle.statuses.thermocouple,
				mode: thermoMode,
				sessionId: th.sessionId ?? null
			}
		};
	});

	// Most recently tested first; never-tested units sink to the bottom.
	rows.sort((a, b) => (b.lastTestAt?.getTime() ?? 0) - (a.lastTestAt?.getTime() ?? 0));

	return { rows: JSON.parse(JSON.stringify(rows)) };
};

export const actions: Actions = {
	/**
	 * Release a unit from the hub. Passing every graded validation (mag +
	 * thermo) in the current cycle is what qualifies a validating unit; pressing Release is the manual
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
				error: `${spu.udi} has ${cycle.passed}/${cycle.total} validations passed this cycle — all must pass before release`
			});
		}

		const who = { _id: locals.user!._id, username: locals.user!.username };
		const now = new Date();
		const reason = `Released from the validation hub — ${cycle.passed}/${cycle.total} validations passed this cycle`;
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
			'Released — magnetometer and thermocouple both passed this validation cycle.',
			who,
			{ source: 'release' }
		);
		// Yellow-LED service flag off (SPU-INV-08) — best-effort, never blocks.
		const serviceFlag = await syncServiceFlag(spuId);

		return { released: true, udi: spu.udi, serviceFlag: serviceFlag.state };
	}
};

export const config = { maxDuration: 60 };
