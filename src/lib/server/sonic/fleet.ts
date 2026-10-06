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
