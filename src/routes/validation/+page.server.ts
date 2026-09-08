import { requirePermission } from '$lib/server/permissions';
import { connectDB, Spu, ValidationSession } from '$lib/server/db';
import type { PageServerLoad } from './$types';

/**
 * SPU Validation hub (SPU-INV-11): the unified fleet view. Each instrument
 * keeps its own execution page — this page answers "where does the fleet
 * stand" with real measurements: gauss at every point (mag), per-channel
 * ratio averages (optics), mode temperature (thermo).
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

	const passedish = (st: string | undefined) => st === 'passed' || st === 'overridden';

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

		const magRollupWells = magWells(v.magnetometer?.results);
		const magSession = magBySpu.get(s._id);
		const wells = magRollupWells ?? magWells(magSession?.magResults);
		const magStatus = v.magnetometer?.status ?? 'pending';

		const opt = v.spectrophotometer ?? {};
		const ratios = opt.results?.ratioByChannel ?? null;

		const th = v.thermocouple ?? {};
		const thermoMode =
			th.results?.stats?.mode ?? th.results?.mode ?? th.results?.overallStats?.mode ?? null;

		const statuses = [magStatus, th.status ?? 'pending', opt.status ?? 'pending'];
		const overall = statuses.every(passedish)
			? 'passed'
			: statuses.some((x) => x === 'failed')
				? 'failed'
				: 'pending';

		// Most recent test of ANY modality — drives the default sort.
		const times = [
			v.magnetometer?.completedAt,
			v.magnetometer?.testRanAt,
			magSession?.at,
			th.completedAt,
			opt.completedAt
		]
			.filter(Boolean)
			.map((t: any) => new Date(t).getTime());
		const lastTestAt = times.length ? new Date(Math.max(...times)) : null;

		return {
			lastTestAt,
			id: s._id,
			udi: s.udi,
			status: s.status ?? 'draft',
			mag: {
				status: magStatus,
				wells,
				zRange: zRange(wells),
				failureReasons: v.magnetometer?.failureReasons ?? [],
				fromSession: !magRollupWells && !!magSession
			},
			optics: {
				status: opt.status ?? 'pending',
				ratios: ratios
					? { A: ratios.A ?? null, B: ratios.B ?? null, C: ratios.C ?? null }
					: null
			},
			thermo: {
				status: th.status ?? 'pending',
				mode: thermoMode
			},
			overall
		};
	});

	// Most recently tested first; never-tested units sink to the bottom.
	rows.sort((a, b) => (b.lastTestAt?.getTime() ?? 0) - (a.lastTestAt?.getTime() ?? 0));

	return { rows: JSON.parse(JSON.stringify(rows)) };
};

export const config = { maxDuration: 60 };
