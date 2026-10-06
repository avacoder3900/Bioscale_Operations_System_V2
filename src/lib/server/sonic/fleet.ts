/**
 * Sonic fleet comparison (2026-10-06, per Alejandro): pick devices, pick what
 * to compare (loudness first), cut the run into fixed time intervals, and in
 * each interval take the fleet's mean and standard deviation. A unit "fits"
 * an interval when its value is inside mean ± K·σ; a unit fits the fleet when
 * enough of its intervals fit.
 *
 * Pure. Input is the aligned series compareFingerprints() already produces,
 * so alignment is the same one the compare page uses. New criteria are added
 * by adding an entry to FLEET_METRICS.
 */
import type { CompareResult } from './compare';
import { mean, std1 } from './stats';

export interface FleetMetric {
	label: string;
	unit: string;
	/** One value per time bin (null = no reading in that bin). */
	pick: (s: CompareResult['series'][number]) => ArrayLike<number | null>;
}

export const FLEET_METRICS = {
	loudness: { label: 'Loudness', unit: 'dB', pick: (s) => s.levelSmooth },
	dominantHz: { label: 'Dominant frequency', unit: 'Hz', pick: (s) => s.domHz }
} satisfies Record<string, FleetMetric>;

export type FleetMetricKey = keyof typeof FLEET_METRICS;
export const isFleetMetric = (k: string): k is FleetMetricKey => k in FLEET_METRICS;

export interface FleetInterval {
	a: number;
	b: number;
	/** Fleet mean / sample σ over the units that have a value here; null when fewer than 2 do. */
	mean: number | null;
	sd: number | null;
	/** Each unit's average over the interval (null = no data). */
	values: (number | null)[];
	/** Inside mean ± K·σ; null where the unit or the fleet has no value. */
	inside: (boolean | null)[];
	/** (value − mean) / σ, signed. */
	z: (number | null)[];
}

export interface FleetUnitSummary {
	scored: number;
	inside: number;
	insidePct: number | null;
	fits: boolean | null;
	/** Interval with the largest |z| — where the unit is furthest from the fleet. */
	worst: { index: number; z: number } | null;
}

export interface FleetSpread {
	k: number;
	intervalS: number;
	minInsidePct: number;
	intervals: FleetInterval[];
	units: FleetUnitSummary[];
}

/** σ below this is treated as this — stops a near-identical fleet flagging everyone. */
const SD_FLOOR: Record<string, number> = { dB: 0.5, Hz: 5 };

export function fleetSpread(
	t: number[],
	series: ArrayLike<number | null>[],
	opts: { intervalS: number; k: number; minInsidePct: number; unit?: string }
): FleetSpread {
	const { intervalS, k, minInsidePct } = opts;
	const floor = SD_FLOOR[opts.unit ?? ''] ?? 0;
	const intervals: FleetInterval[] = [];
	if (t.length && intervalS > 0) {
		const half = t.length > 1 ? (t[1] - t[0]) / 2 : 0;
		const start = t[0] - half;
		const end = t[t.length - 1] + half;
		for (let a = start; a < end - 1e-9; a += intervalS) {
			const b = Math.min(a + intervalS, end);
			const idx = t.flatMap((tk, i) => (tk >= a && tk < b ? [i] : []));
			const values = series.map((s) => {
				const vs = idx.map((i) => s[i]).filter((v): v is number => v != null && Number.isFinite(v));
				return vs.length ? mean(vs) : null;
			});
			const have = values.filter((v): v is number => v != null);
			const m = have.length >= 2 ? mean(have) : null;
			const sd = have.length >= 2 ? Math.max(std1(have), floor) : null;
			const z = values.map((v) => (v == null || m == null || !sd ? null : (v - m) / sd));
			intervals.push({ a, b, mean: m, sd, values, z, inside: z.map((zz) => (zz == null ? null : Math.abs(zz) <= k)) });
		}
	}
	const units: FleetUnitSummary[] = series.map((_, u) => {
		let scored = 0;
		let inside = 0;
		let worst: FleetUnitSummary['worst'] = null;
		intervals.forEach((iv, i) => {
			const zz = iv.z[u];
			if (zz == null) return;
			scored++;
			if (iv.inside[u]) inside++;
			if (!worst || Math.abs(zz) > Math.abs(worst.z)) worst = { index: i, z: zz };
		});
		const insidePct = scored ? (100 * inside) / scored : null;
		return { scored, inside, insidePct, fits: insidePct == null ? null : insidePct >= minInsidePct, worst };
	});
	return { k, intervalS, minInsidePct, intervals, units };
}

const r1 = (v: number | null) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);

export interface FleetOptions {
	metric: FleetMetricKey;
	intervalS: number;
	k: number;
	minInsidePct: number;
	/**
	 * Loudness only: remove each recording's own average level first, so only the
	 * shape over time is compared. A phone held closer or farther shifts the whole
	 * curve; without this, that alone can push a good unit outside the band.
	 */
	shapeOnly: boolean;
}

/** The Fleet check view of a comparison, rounded and ready to serialize. */
export function fleetView(cmp: CompareResult, opts: FleetOptions) {
	const m: FleetMetric = FLEET_METRICS[opts.metric];
	let series = cmp.series.map((s) => Array.from(m.pick(s), (v) => (v == null || !Number.isFinite(v) ? null : v)));
	const shapeOnly = opts.shapeOnly && opts.metric === 'loudness';
	if (shapeOnly) {
		const means = series.map((s) => mean(s.filter((v): v is number => v != null)));
		const grand = mean(means.filter((v) => Number.isFinite(v)));
		series = series.map((s, i) => s.map((v) => (v == null ? null : v - means[i] + grand)));
	}
	const spread = fleetSpread(cmp.t, series, { intervalS: opts.intervalS, k: opts.k, minInsidePct: opts.minInsidePct, unit: m.unit });
	const at = (tk: number) => spread.intervals.find((iv) => tk >= iv.a && tk < iv.b);
	return {
		metric: { key: opts.metric, label: m.label, unit: m.unit },
		shapeOnly,
		intervalS: opts.intervalS,
		k: opts.k,
		minInsidePct: opts.minInsidePct,
		series: series.map((s) => s.map(r1)),
		units: spread.units.map((u) => ({ ...u, insidePct: u.insidePct == null ? null : Math.round(u.insidePct) })),
		band: { mu: cmp.t.map((tk) => r1(at(tk)?.mean ?? null)), sd: cmp.t.map((tk) => r1(at(tk)?.sd ?? null)), k: opts.k },
		intervals: spread.intervals.map((iv) => ({
			a: r1(iv.a)!,
			b: r1(iv.b)!,
			mean: r1(iv.mean),
			sd: r1(iv.sd),
			values: iv.values.map(r1),
			inside: iv.inside,
			z: iv.z.map(r1)
		}))
	};
}

export type FleetView = ReturnType<typeof fleetView>;
