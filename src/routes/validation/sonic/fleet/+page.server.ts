import { requirePermission } from '$lib/server/permissions';
import { connectDB, ValidationSession } from '$lib/server/db';
import { loadFingerprints } from '$lib/server/sonic/analyze';
import { compareFingerprints } from '$lib/server/sonic/compare';
import { FLEET_METRICS, fleetSpread, isFleetMetric, type FleetMetricKey } from '$lib/server/sonic/fleet';
import type { PageServerLoad } from './$types';

/**
 * Sonic fleet comparison (2026-10-06): the simple view. Pick devices and a
 * metric; each device contributes its LATEST analyzed recording of the chosen
 * assay; the run is cut into fixed intervals and each unit is scored against
 * the fleet's mean ± K·σ per interval. The detailed section-by-section view
 * stays at /validation/sonic/compare.
 *
 *   ?assay=SONIC&spus=BT-…-0210,BT-…-0226&metric=loudness&interval=10&k=1&min=75
 */
const MAX_UNITS = 30;

const spuShort = (udi: string) => {
	const m = /-0*(\d+)$/.exec(udi);
	return m ? `SPU ${m[1]}` : udi;
};
const r1 = (v: number | null) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
const clampNum = (raw: string | null, d: number, lo: number, hi: number) => {
	const v = Number(raw);
	return raw != null && raw !== '' && Number.isFinite(v) ? Math.min(Math.max(v, lo), hi) : d;
};

export const load: PageServerLoad = async ({ locals, url }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	// Picker: the latest usable, analyzed recording per (SPU, assay) — no fingerprints.
	const recs = (await ValidationSession.find({
		type: 'sonic',
		'results.0.processedData.fingerprint': { $type: 'object' },
		'results.0.rawData.review.status': { $ne: 'unusable' }
	})
		.select('spuUdi createdAt results.rawData.assay')
		.sort({ createdAt: -1 })
		.limit(500)
		.lean()) as any[];
	const latest = new Map<string, { id: string; spuUdi: string; short: string; assay: string; at: string | null }>();
	for (const r of recs) {
		const udi = (r.spuUdi ?? '?') as string;
		const assay = (r.results?.[0]?.rawData?.assay ?? 'UNSET') as string;
		const key = `${assay}|${udi}`;
		if (!latest.has(key)) {
			latest.set(key, { id: r._id, spuUdi: udi, short: spuShort(udi), assay, at: r.createdAt ? new Date(r.createdAt).toISOString() : null });
		}
	}
	const available = [...latest.values()].sort((a, b) => a.short.localeCompare(b.short, undefined, { numeric: true }));
	const assays = [...new Set(available.map((a) => a.assay))].sort((a, b) =>
		// Most-recorded assay first — that is the one people compare.
		available.filter((x) => x.assay === b).length - available.filter((x) => x.assay === a).length
	);

	const assay = url.searchParams.get('assay') || assays[0] || null;
	const metricRaw = url.searchParams.get('metric') ?? 'loudness';
	const metric: FleetMetricKey = isFleetMetric(metricRaw) ? metricRaw : 'loudness';
	const intervalS = clampNum(url.searchParams.get('interval'), 10, 1, 120);
	const k = clampNum(url.searchParams.get('k'), 1, 0.5, 4);
	const minInsidePct = clampNum(url.searchParams.get('min'), 75, 0, 100);
	const spus = [...new Set((url.searchParams.get('spus') ?? '').split(',').map((s) => s.trim()).filter(Boolean))];

	const base = {
		available,
		assays,
		metrics: Object.entries(FLEET_METRICS).map(([key, m]) => ({ key, label: m.label, unit: m.unit })),
		params: { assay, metric, intervalS, k, minInsidePct, spus }
	};
	const chosen = available.filter((a) => a.assay === assay && spus.includes(a.spuUdi));
	if (chosen.length < 3) {
		return { ...base, result: null, error: spus.length ? 'Pick at least 3 devices — a standard deviation needs a fleet.' : null };
	}
	if (chosen.length > MAX_UNITS) {
		return { ...base, result: null, error: `Compare at most ${MAX_UNITS} devices at a time (${chosen.length} selected).` };
	}

	const fps = await loadFingerprints({ _id: { $in: chosen.map((c) => c.id) } });
	const byId = new Map(fps.map((f) => [f.id, f]));
	const rows = chosen.map((c) => ({ c, f: byId.get(c.id) })).filter((r): r is { c: (typeof chosen)[number]; f: NonNullable<typeof r.f> } => !!r.f);
	if (rows.length < 3) return { ...base, result: null, error: 'Fewer than 3 of the chosen recordings could be loaded.' };

	let cmp;
	try {
		cmp = compareFingerprints(rows.map((r) => ({ id: r.f.id, label: r.c.short, fp: r.f.fp })));
	} catch (err) {
		return { ...base, result: null, error: err instanceof Error ? err.message : String(err) };
	}
	const m = FLEET_METRICS[metric];
	const series = cmp.series.map((s) => Array.from(m.pick(s), (v) => (v == null || !Number.isFinite(v) ? null : v)));
	const spread = fleetSpread(cmp.t, series, { intervalS, k, minInsidePct, unit: m.unit });

	// Per-bin band (step function of the interval stats) for the chart.
	const bandMu = cmp.t.map((tk) => r1(spread.intervals.find((iv) => tk >= iv.a && tk < iv.b)?.mean ?? null));
	const bandSd = cmp.t.map((tk) => r1(spread.intervals.find((iv) => tk >= iv.a && tk < iv.b)?.sd ?? null));

	return {
		...base,
		error: null,
		result: {
			metric: { key: metric, label: m.label, unit: m.unit },
			t: cmp.t,
			window: cmp.window.map((v) => Math.round(v * 10) / 10) as [number, number],
			units: rows.map((r, i) => ({
				id: r.f.id,
				spuUdi: r.c.spuUdi,
				short: r.c.short,
				at: r.f.at,
				offset: Math.round(cmp.offsets[i] * 100) / 100,
				series: series[i].map(r1),
				...spread.units[i],
				insidePct: spread.units[i].insidePct == null ? null : Math.round(spread.units[i].insidePct!)
			})),
			band: { mu: bandMu, sd: bandSd, k },
			intervals: spread.intervals.map((iv) => ({
				a: r1(iv.a)!,
				b: r1(iv.b)!,
				mean: r1(iv.mean),
				sd: r1(iv.sd),
				values: iv.values.map(r1),
				inside: iv.inside,
				z: iv.z.map(r1)
			}))
		}
	};
};
