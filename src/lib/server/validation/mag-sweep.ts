/**
 * Magnetometer stage-sweep analysis — shared by both ingest paths.
 *
 * Two transports deliver the same physical run:
 *   - POST /api/agent/validation/mag-sweep  — a bench-side pusher parses the
 *     SWPBEGIN/S/SWPEND serial text and posts per-rep RAW rows.
 *   - POST /api/particle/webhook            — the device itself uploads the
 *     sweep in ~1 KB Particle publishes; its rows are per-position MEANS.
 *
 * Everything below the transport is identical, so it lives here once. Both
 * paths must produce byte-identical magResults for the same physical sweep.
 */

// Field offsets within a RAW row AFTER the leading "S" tag is stripped:
// [0]=y(microns) [1]=well [2]=rep then (t,x,y,z) per channel.
export const ROW_Y = 0;
export const ROW_WELL = 1;
export const ROW_REP = 2;
export const CHANNELS = [
	{ ch: 'A', t: 3, x: 4, y: 5, z: 6 },
	{ ch: 'B', t: 7, x: 8, y: 9, z: 10 },
	{ ch: 'C', t: 11, x: 12, y: 13, z: 14 }
] as const;
export const ROW_FIELDS = 15;

/** Column names of a raw per-rep row, in order. Stored as rawData.fields. */
export const RAW_FIELDS = [
	'y', 'well', 'rep',
	'tA', 'xA', 'yA', 'zA',
	'tB', 'xB', 'yB', 'zB',
	'tC', 'xC', 'yC', 'zC'
];

/**
 * Optional per-channel noise columns, appended past the 15 raw columns.
 *
 * The device discards per-rep rows to keep the upload small, so sd{CH} — the
 * standard deviation of |B| over the reps at that stage position — is the only
 * noise estimate a means upload carries. aggregate() reads nothing past index
 * 14, so a row carrying these is analysed identically to one that does not.
 */
export const SD_OFFSET_BY_CHANNEL: Record<string, number> = { A: 15, B: 16, C: 17 };
export const ROW_FIELDS_WITH_SD = 18;

export const MAX_ROWS = 20000;

export type Agg = { y: number; bx: number; by: number; bz: number; t: number; mag: number; reps: number };

/** Mean each component over reps at a given stage position, then derive |B|. */
export function aggregate(rows: number[][]): Map<string, Agg[]> {
	const acc = new Map<string, Map<number, { bx: number; by: number; bz: number; t: number; n: number }>>();

	for (const r of rows) {
		const y = r[ROW_Y];
		const well = r[ROW_WELL];
		if (!Number.isFinite(y) || !Number.isFinite(well)) continue;

		for (const c of CHANNELS) {
			const bx = r[c.x], by = r[c.y], bz = r[c.z], t = r[c.t];
			if (![bx, by, bz].every(Number.isFinite)) continue;

			const key = `${well}|${c.ch}`;
			let byPos = acc.get(key);
			if (!byPos) { byPos = new Map(); acc.set(key, byPos); }

			const cur = byPos.get(y) ?? { bx: 0, by: 0, bz: 0, t: 0, n: 0 };
			cur.bx += bx; cur.by += by; cur.bz += bz;
			cur.t += Number.isFinite(t) ? t : 0;
			cur.n += 1;
			byPos.set(y, cur);
		}
	}

	const out = new Map<string, Agg[]>();
	for (const [key, byPos] of acc) {
		const series = [...byPos.entries()]
			.map(([y, s]) => {
				const bx = s.bx / s.n, by = s.by / s.n, bz = s.bz / s.n;
				return { y, bx, by, bz, t: s.t / s.n, mag: Math.sqrt(bx * bx + by * by + bz * bz), reps: s.n };
			})
			.sort((a, b) => a.y - b.y);
		out.set(key, series);
	}
	return out;
}

/** Peak position, amplitude and full-width-half-max of the |B| profile. */
export function profile(series: Agg[]) {
	if (series.length === 0) return null;

	let peak = series[0];
	for (const p of series) if (p.mag > peak.mag) peak = p;

	const baseline = Math.min(...series.map((p) => p.mag));
	const half = baseline + (peak.mag - baseline) / 2;
	const peakIdx = series.indexOf(peak);

	// Walk outward from the peak to the first half-max crossing on each side and
	// linearly interpolate. Null when the sweep window clipped the shoulder.
	const cross = (dir: -1 | 1): number | null => {
		for (let i = peakIdx; i >= 0 && i < series.length; i += dir) {
			const next = i + dir;
			if (next < 0 || next >= series.length) return null;
			if (series[next].mag <= half) {
				const a = series[i], b = series[next];
				const span = a.mag - b.mag;
				if (span === 0) return b.y;
				return a.y + ((a.mag - half) / span) * (b.y - a.y);
			}
		}
		return null;
	};

	const left = cross(-1), right = cross(1);

	// Well 5 crests beyond STAGE_POSITION_LIMIT, so the stage runs out of travel
	// while |B| is still climbing. That is a travel-limited well — not a failed
	// one and not truncated data — so characterise it by the slope of its rising
	// tail instead of a peak the stage physically cannot reach.
	const lastIdx = series.length - 1;
	const distal = peakIdx >= lastIdx && right === null;
	const proximal = !distal && peakIdx <= 0 && left === null;
	const travelLimited = distal || proximal;
	const edge: 'none' | 'distal' | 'proximal' = distal ? 'distal' : proximal ? 'proximal' : 'none';

	// Least-squares fit of |B| against y over the rising tail leading to that edge.
	const fitRisingTail = () => {
		const tailCount = Math.max(3, Math.ceil(series.length * 0.3));
		const lo = left, hi = right;
		let seg: Agg[];
		if (distal) {
			seg = lo !== null ? series.filter((p, i) => i <= peakIdx && p.y >= lo) : [];
			if (seg.length < 3) seg = series.slice(Math.max(0, series.length - tailCount));
		} else {
			seg = hi !== null ? series.filter((p, i) => i >= peakIdx && p.y <= hi) : [];
			if (seg.length < 3) seg = series.slice(0, tailCount);
		}
		if (seg.length < 2) return null;

		const n = seg.length;
		const meanY = seg.reduce((a, p) => a + p.y, 0) / n;
		const meanMag = seg.reduce((a, p) => a + p.mag, 0) / n;
		let sxx = 0, sxy = 0, syy = 0;
		for (const p of seg) {
			const dy = p.y - meanY, dm = p.mag - meanMag;
			sxx += dy * dy;
			sxy += dy * dm;
			syy += dm * dm;
		}
		if (!(sxx > 0)) return null;

		const slope = sxy / sxx;
		if (!Number.isFinite(slope)) return null;
		const rawR2 = syy > 0 ? (sxy * sxy) / (sxx * syy) : NaN;

		return {
			// |B| units per 1000 microns (per mm of stage travel).
			slopePerMm: Number((slope * 1000).toFixed(3)),
			slopeR2: Number.isFinite(rawR2) ? Number(Math.min(1, Math.max(0, rawR2)).toFixed(4)) : null,
			slopeSpanY: [seg[0].y, seg[n - 1].y] as [number, number]
		};
	};

	const fit = travelLimited ? fitRisingTail() : null;

	return {
		peakY: peak.y,
		peakMag: Number(peak.mag.toFixed(3)),
		peakBx: Number(peak.bx.toFixed(3)),
		peakBy: Number(peak.by.toFixed(3)),
		peakBz: Number(peak.bz.toFixed(3)),
		baseline: Number(baseline.toFixed(3)),
		amplitude: Number((peak.mag - baseline).toFixed(3)),
		fwhm: left !== null && right !== null ? Number((right - left).toFixed(1)) : null,
		halfMaxLeftY: left !== null ? Number(left.toFixed(1)) : null,
		halfMaxRightY: right !== null ? Number(right.toFixed(1)) : null,
		clipped: left === null || right === null,
		points: series.length,
		yMin: series[0].y,
		yMax: series[series.length - 1].y,
		travelLimited,
		edge,
		slopePerMm: fit ? fit.slopePerMm : null,
		slopeR2: fit ? fit.slopeR2 : null,
		slopeSpanY: fit ? fit.slopeSpanY : null,
		method: travelLimited ? ('slope' as const) : ('peak' as const)
	};
}

/**
 * Normalise a caller-supplied rows[] to exactly ROW_FIELDS numeric columns.
 * Rows shorter than a full record are dropped rather than padded: a short row
 * means the transport lost fields, and zero-filling them would file invented
 * measurements against a real stage position.
 */
export function cleanRawRows(rows: unknown): number[][] {
	const clean: number[][] = [];
	if (!Array.isArray(rows)) return clean;
	for (const r of rows) {
		if (!Array.isArray(r) || r.length < ROW_FIELDS) continue;
		clean.push(r.slice(0, ROW_FIELDS).map(Number));
	}
	return clean;
}

export type SweepEnd = { rows?: number; good?: number; ms?: number } | null | undefined;

const r3 = (v: number) => Number(v.toFixed(3));
const r4 = (v: number) => Number(v.toFixed(4));
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;

/** Mean sd per stage position, keyed `well|channel`. Empty unless rows carry SDs. */
function collectSd(rows: number[][]): Map<string, Map<number, number>> {
	const acc = new Map<string, Map<number, { sum: number; n: number }>>();

	for (const r of rows) {
		if (r.length < ROW_FIELDS_WITH_SD) continue;
		const y = r[ROW_Y], well = r[ROW_WELL];
		if (!Number.isFinite(y) || !Number.isFinite(well)) continue;

		for (const c of CHANNELS) {
			const sd = r[SD_OFFSET_BY_CHANNEL[c.ch]];
			if (!Number.isFinite(sd)) continue;

			const key = `${well}|${c.ch}`;
			let byPos = acc.get(key);
			if (!byPos) { byPos = new Map(); acc.set(key, byPos); }
			const cur = byPos.get(y) ?? { sum: 0, n: 0 };
			cur.sum += sd; cur.n += 1;
			byPos.set(y, cur);
		}
	}

	const out = new Map<string, Map<number, number>>();
	for (const [key, byPos] of acc) {
		const m = new Map<number, number>();
		for (const [y, s] of byPos) m.set(y, s.sum / s.n);
		out.set(key, m);
	}
	return out;
}

/**
 * Rep-spread summary for one well/channel.
 *
 * The spread is the device's sd{CH}: the sample standard deviation (n-1) of
 * |B| over the repetitions at one stage position — NOT a per-axis spread, and
 * not a spread of Z. It is |B| in the device's RAW units, so the four-fold
 * zscale inflation on Z is still inside it. That makes it a noise figure, not a
 * physical field magnitude; comparing it against a calibrated |B| is wrong.
 *
 * Reported as a coefficient of variation as well as an absolute spread: the
 * measured rep CV on this hardware is 0.03-0.05%, so an out-of-family value is
 * a fault signal, and a CV stays comparable between wells whose |B| differ by
 * an order of magnitude.
 */
function noiseFrom(series: Agg[], sds: Map<number, number>, peakY: number) {
	const pairs = series
		.map((p) => ({ mag: p.mag, sd: sds.get(p.y) }))
		.filter((p): p is { mag: number; sd: number } => Number.isFinite(p.sd));
	if (pairs.length === 0) return null;

	const vals = pairs.map((p) => p.sd);
	const cvs = pairs.filter((p) => p.mag > 0).map((p) => (p.sd / p.mag) * 100);
	const atPeak = sds.get(peakY);
	const peakMag = series.find((p) => p.y === peakY)?.mag ?? 0;
	const hasPeak = Number.isFinite(atPeak);

	return {
		sdMean: r3(mean(vals)),
		sdMin: r3(Math.min(...vals)),
		sdMax: r3(Math.max(...vals)),
		sdAtPeak: hasPeak ? r3(atPeak as number) : null,
		cvMeanPct: cvs.length > 0 ? r4(mean(cvs)) : null,
		cvMaxPct: cvs.length > 0 ? r4(Math.max(...cvs)) : null,
		cvAtPeakPct: hasPeak && peakMag > 0 ? r4(((atPeak as number) / peakMag) * 100) : null,
		points: pairs.length
	};
}

/**
 * Per-well/channel profiles plus the magResults block, derived from raw rows.
 * This is the whole analysis contract — every ingest path calls exactly this,
 * so no path can drift from another.
 *
 * A `noise` key is attached to a profile ONLY when the rows actually carried
 * standard deviations. Per-rep raw rows (the bench-side path) have none, and
 * must keep producing exactly the document they produced before this existed.
 */
export function summarise(clean: number[][], end?: SweepEnd) {
	const series = aggregate(clean);
	const sdByKey = collectSd(clean);
	const wells: Record<string, unknown> = {};
	for (const [key, s] of series) {
		const [well, ch] = key.split('|');
		const p = profile(s);
		if (!p) continue;
		const sds = sdByKey.get(key);
		const noise = sds && sds.size > 0 ? noiseFrom(s, sds, p.peakY) : null;
		((wells[well] ??= {}) as Record<string, unknown>)[ch] = noise ? { ...p, noise } : p;
	}

	const wellNumbers = [...new Set(clean.map((r) => r[ROW_WELL]))].sort((a, b) => a - b);

	return {
		wells,
		wellNumbers,
		magResults: {
			wells,
			wellNumbers,
			channels: CHANNELS.map((c) => c.ch),
			rowsIngested: clean.length,
			rowsReported: end?.rows ?? null,
			goodReported: end?.good ?? null,
			durationMs: end?.ms ?? null
		}
	};
}
