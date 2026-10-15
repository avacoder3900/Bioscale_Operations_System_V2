/**
 * Magnetometer sweep analysis — derive-on-read, pure.
 *
 * Reproduces the per-well/per-channel result block the Sept 25 analysis
 * (scratch sweep.cjs / build-sweep.cjs, since lost) wrote into
 * validation_sessions.magResults.wells[w][ch] for the 32 serial-captured sweeps,
 * so cloud-uploaded sweeps land in the same shape and the same charts.
 *
 * Physics in one line: pull on a bead scales with Bz × dBz/dz. The stage has no
 * Z axis, but div B = 0 and the magnet's axial symmetry give
 *   dBz/dz ≈ −2 · dBx/dx
 * where x is the travel direction, so the slope of Bx through the peak IS the
 * vertical gradient. forceIndex = peakBz × gradBzdz. These are the quantities
 * that ranked with the exp-357 bead index at Spearman 0.84; peak Bz alone
 * (the fixed-position test) did not (−0.34).
 *
 * Method (matches the stored sessions to the rounding shown there):
 *   - pool reps per (y, well): mean of each field (fmt=2 raw rows) — fmt=3 rows
 *     are already means.
 *   - |B| = sqrt(x² + y² + z²) per point; peak = max |B| point in the window.
 *   - baseline = median of the lowest 10 % of |B|; amplitude = peakMag − baseline.
 *   - FWHM from the half-max crossings around the peak (linear interpolation).
 *   - dBxdTravel = least-squares slope of Bx vs y (per µm) over the points
 *     within ±SLOPE_HALF_SPAN_UM of the peak; gradBzdz = −2 × that;
 *     forceIndex = peakBz × gradBzdz; byAtPeakPct = |By| / |B| at the peak (an
 *     off-axis indicator).
 *   - flags: clipped (|B| at a sensor rail), peakAtWindowEdge, travelLimited.
 */

export interface SweepPointSeries {
	y: number[];
	t: number[];
	x: number[];
	yB: number[];
	z: number[];
	sd: number[];
}

export interface WellChannelResult {
	peakY: number | null;
	peakMag: number | null;
	peakBx: number | null;
	peakBy: number | null;
	peakBz: number | null;
	baseline: number | null;
	amplitude: number | null;
	fwhm: number | null;
	halfMaxLeftY: number | null;
	halfMaxRightY: number | null;
	clipped: boolean;
	points: number;
	yMin: number | null;
	yMax: number | null;
	travelLimited: boolean;
	edge: 'none' | 'left' | 'right';
	peakAtWindowEdge: boolean;
	slopePerMm: number | null;
	slopeR2: number | null;
	slopeSpanY: number | null;
	method: 'peak';
	dBxdTravel: number | null;
	gradBzdz: number | null;
	forceIndex: number | null;
	byAtPeakPct: number | null;
	peakUnreliable: boolean;
	/** Why the cell is unreliable, in operator words. Empty when it is fine. */
	reasons: string[];
	/** Mean repeat sd of |B| over the slope window (fmt=3 rows only). */
	noiseSd: number | null;
	/** Mean die temperature over the window (°C as the Argon converts it). */
	tempMean: number | null;
}

export interface SweepAnalysis {
	wells: Record<string, Record<string, WellChannelResult>>;
	wellNumbers: number[];
	channels: string[];
	rowsIngested: number;
	rowsReported: number;
	goodReported: number;
	rowsMissing: number;
	coverage: number;
	coverageComplete: boolean;
	durationMs: number | null;
	/** Quick fleet summary: min lane gradient and its well/channel. */
	minGradient: { value: number; well: number; channel: string } | null;
	minForceIndex: { value: number; well: number; channel: string } | null;
}

const CHANNELS = ['A', 'B', 'C'] as const;
/**
 * ±1.5 mm around the peak: the straight part of the Bx zero-crossing on an 8 mm
 * pitch. Docs/SWEEP_RESOLUTION_ANALYSIS.md (brevitest-device, 2026-10-13): this
 * exact span reproduces the stored magResults to 0.00 %; ±1,200 or ±1,600
 * already differ by 3 %, so it is stated here, not left to a default.
 */
export const SLOPE_HALF_SPAN_UM = 1500;
/** A peak closer than this to its window edge is "off nominal": route to a full sweep + SCREEN. */
export const EDGE_FLAG_UM = 1500;
/** Fleet-nominal peak positions per well (µm) and pitch, from the 32 sweeps on file. */
export const NOMINAL_PEAKS_UM = [5494, 13473, 21458, 29467, 37509] as const;
export const NOMINAL_PITCH_UM = 8000;
/** ALS31313 12-bit field rail in raw units, before zscale. */
const RAIL = 2047;

function mean(a: number[]): number {
	return a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN;
}
function median(a: number[]): number {
	if (!a.length) return NaN;
	const s = [...a].sort((p, q) => p - q);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function r3(v: number | null): number | null {
	return v == null || !Number.isFinite(v) ? null : Math.round(v * 1000) / 1000;
}
function r5(v: number | null): number | null {
	return v == null || !Number.isFinite(v) ? null : Math.round(v * 100000) / 100000;
}

/** Group rows by (well) → series sorted by y, pooling reps. */
export function sweepSeries(fields: string[], rows: number[][]): Map<number, Map<string, SweepPointSeries>> {
	const ix = (name: string) => fields.indexOf(name);
	const iy = ix('y'),
		iw = ix('well');
	const out = new Map<number, Map<string, SweepPointSeries>>();
	// (well, channel) → y → accumulators
	const acc = new Map<string, Map<number, { t: number[]; x: number[]; yB: number[]; z: number[]; sd: number[] }>>();
	for (const row of rows) {
		const y = row[iy],
			well = row[iw];
		for (const ch of CHANNELS) {
			const it = ix(`t${ch}`),
				ixx = ix(`x${ch}`),
				iyy = ix(`y${ch}`),
				iz = ix(`z${ch}`),
				isd = ix(`sd${ch}`);
			if (ixx < 0 || iz < 0) continue;
			const key = `${well}:${ch}`;
			if (!acc.has(key)) acc.set(key, new Map());
			const byY = acc.get(key)!;
			if (!byY.has(y)) byY.set(y, { t: [], x: [], yB: [], z: [], sd: [] });
			const a = byY.get(y)!;
			const sd = isd >= 0 ? row[isd] : NaN;
			// sd < 0 is the firmware's "nothing read here" marker: skip the placeholder.
			if (isd >= 0 && sd < 0) continue;
			a.t.push(it >= 0 ? row[it] : NaN);
			a.x.push(row[ixx]);
			a.yB.push(iyy >= 0 ? row[iyy] : 0);
			a.z.push(row[iz]);
			if (Number.isFinite(sd)) a.sd.push(sd);
		}
	}
	for (const [key, byY] of acc) {
		const [wellS, ch] = key.split(':');
		const well = Number(wellS);
		const ys = [...byY.keys()].sort((p, q) => p - q);
		const s: SweepPointSeries = { y: [], t: [], x: [], yB: [], z: [], sd: [] };
		for (const y of ys) {
			const a = byY.get(y)!;
			if (!a.x.length) continue;
			s.y.push(y);
			s.t.push(mean(a.t));
			s.x.push(mean(a.x));
			s.yB.push(mean(a.yB));
			s.z.push(mean(a.z));
			s.sd.push(a.sd.length ? mean(a.sd) : NaN);
		}
		if (!out.has(well)) out.set(well, new Map());
		out.get(well)!.set(ch, s);
	}
	return out;
}

function linearFit(xs: number[], ys: number[]): { slope: number; r2: number } | null {
	const n = xs.length;
	if (n < 3) return null;
	const mx = mean(xs),
		my = mean(ys);
	let sxx = 0,
		sxy = 0,
		syy = 0;
	for (let i = 0; i < n; i++) {
		sxx += (xs[i] - mx) ** 2;
		sxy += (xs[i] - mx) * (ys[i] - my);
		syy += (ys[i] - my) ** 2;
	}
	if (sxx === 0) return null;
	const slope = sxy / sxx;
	const r2 = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy);
	return { slope, r2 };
}

/** Analyse one well/channel series, optionally restricted to [yLo, yHi]. */
export function analyzeSeries(
	s: SweepPointSeries,
	opts: { yLo?: number; yHi?: number; travelLimit?: number } = {}
): WellChannelResult {
	const idx = s.y.map((_, i) => i).filter((i) => (opts.yLo == null || s.y[i] >= opts.yLo) && (opts.yHi == null || s.y[i] <= opts.yHi));
	const empty: WellChannelResult = {
		peakY: null, peakMag: null, peakBx: null, peakBy: null, peakBz: null, baseline: null, amplitude: null,
		fwhm: null, halfMaxLeftY: null, halfMaxRightY: null, clipped: false, points: idx.length,
		yMin: null, yMax: null, travelLimited: false, edge: 'none', peakAtWindowEdge: false,
		slopePerMm: null, slopeR2: null, slopeSpanY: null, method: 'peak', dBxdTravel: null, gradBzdz: null,
		forceIndex: null, byAtPeakPct: null, peakUnreliable: true, reasons: ['no peak in window'], noiseSd: null, tempMean: null
	};
	if (idx.length < 3) return empty;

	const y = idx.map((i) => s.y[i]);
	const bx = idx.map((i) => s.x[i]);
	const by = idx.map((i) => s.yB[i]);
	const bz = idx.map((i) => s.z[i]);
	const mag = bz.map((z, i) => Math.sqrt(bx[i] ** 2 + by[i] ** 2 + z ** 2));
	const sds = idx.map((i) => s.sd[i]);
	const temps = idx.map((i) => s.t[i]).filter(Number.isFinite);

	let p = 0;
	for (let i = 1; i < mag.length; i++) if (mag[i] > mag[p]) p = i;
	const peakMag = mag[p];
	const low = [...mag].sort((a, b) => a - b).slice(0, Math.max(1, Math.floor(mag.length * 0.1)));
	const baseline = median(low);
	const amplitude = peakMag - baseline;
	const half = baseline + amplitude / 2;

	// Half-max crossings, interpolated.
	let left: number | null = null,
		right: number | null = null;
	for (let i = p; i > 0; i--) {
		if (mag[i - 1] <= half) {
			const f = (mag[i] - half) / (mag[i] - mag[i - 1] || 1);
			left = y[i] - f * (y[i] - y[i - 1]);
			break;
		}
	}
	for (let i = p; i < mag.length - 1; i++) {
		if (mag[i + 1] <= half) {
			const f = (mag[i] - half) / (mag[i] - mag[i + 1] || 1);
			right = y[i] + f * (y[i + 1] - y[i]);
			break;
		}
	}
	const fwhm = left != null && right != null ? right - left : null;

	// Slope of Bx through the peak.
	const win = y.map((v, i) => i).filter((i) => Math.abs(y[i] - y[p]) <= SLOPE_HALF_SPAN_UM);
	const fit = linearFit(win.map((i) => y[i]), win.map((i) => bx[i]));
	const dBxdTravel = fit ? fit.slope : null; // per µm
	const gradBzdz = dBxdTravel != null ? -2 * dBxdTravel : null;
	const forceIndex = gradBzdz != null ? bz[p] * gradBzdz : null;
	const spanY = win.length ? y[win[win.length - 1]] - y[win[0]] : null;

	const clipped = bz.some((v) => Math.abs(v) >= RAIL * 4 - 4) || bx.some((v) => Math.abs(v) >= RAIL - 1) || by.some((v) => Math.abs(v) >= RAIL - 1);
	// Edge rule (SWEEP_RESOLUTION_ANALYSIS.md): a peak within EDGE_FLAG_UM of the
	// window edge cannot be fitted on both flanks. On a segmented sweep that means
	// the unit's peak is off the fleet-nominal position — most often a stage that
	// lost travel during the sweep (0247, 0223 first run), not a magnet fault.
	const nearLeft = y[p] - y[0] < EDGE_FLAG_UM;
	const nearRight = y[y.length - 1] - y[p] < EDGE_FLAG_UM;
	const edge: WellChannelResult['edge'] = nearLeft ? 'left' : nearRight ? 'right' : 'none';
	const travelLimited = opts.travelLimit != null && y[y.length - 1] >= opts.travelLimit;
	const peakAtWindowEdge = edge !== 'none';
	const noise = sds.filter((v, i) => Number.isFinite(v) && win.includes(i));
	// A "peak" that is not a peak: no rise above the baseline, or the window holds
	// only one flank. Both mean the field maximum is outside the window.
	const noPeak = amplitude <= 0 || (nearLeft && nearRight) || (p === 0 || p === mag.length - 1);
	const reasons: string[] = [];
	if (noPeak) reasons.push('no peak in window');
	else if (peakAtWindowEdge) reasons.push(`peak at window edge (${edge}) — off nominal, run a full sweep + SCREEN`);
	if (clipped) reasons.push('sensor clipped');
	if (win.length < 5) reasons.push('too few points for the slope fit');

	return {
		peakY: y[p],
		peakMag: r3(peakMag),
		peakBx: r3(bx[p]),
		peakBy: r3(by[p]),
		peakBz: r3(bz[p]),
		baseline: r3(baseline),
		amplitude: r3(amplitude),
		fwhm: r3(fwhm),
		halfMaxLeftY: r3(left),
		halfMaxRightY: r3(right),
		clipped,
		points: idx.length,
		yMin: y[0],
		yMax: y[y.length - 1],
		travelLimited,
		edge,
		peakAtWindowEdge,
		slopePerMm: null,
		slopeR2: fit ? r5(fit.r2) : null,
		slopeSpanY: spanY,
		method: 'peak',
		dBxdTravel: r5(dBxdTravel),
		gradBzdz: r5(gradBzdz),
		forceIndex: forceIndex != null ? Math.round(forceIndex * 10) / 10 : null,
		byAtPeakPct: peakMag > 0 ? r3((Math.abs(by[p]) / peakMag) * 100) : null,
		peakUnreliable: reasons.length > 0,
		reasons,
		noiseSd: noise.length ? r3(mean(noise)) : null,
		tempMean: temps.length ? r3(mean(temps)) : null
	};
}

export function analyzeSweep(
	fields: string[],
	rows: number[][],
	opts: { rowsReported?: number; goodReported?: number; rowsMissing?: number; durationMs?: number | null; travelLimit?: number } = {}
): SweepAnalysis {
	// Each well's series only holds the y values at which that well was read, so
	// a segmented sweep (one well per segment) analyses each well over its own
	// window with no special casing; a continuous sweep sees every y for every well.
	const series = sweepSeries(fields, rows);
	const wells: SweepAnalysis['wells'] = {};
	const wellNumbers = [...series.keys()].sort((a, b) => a - b);
	let minG: SweepAnalysis['minGradient'] = null;
	let minF: SweepAnalysis['minForceIndex'] = null;
	for (const well of wellNumbers) {
		wells[String(well)] = {};
		for (const ch of CHANNELS) {
			const s = series.get(well)!.get(ch);
			if (!s) continue;
			const r = analyzeSeries(s, { travelLimit: opts.travelLimit });
			wells[String(well)][ch] = r;
			if (r.gradBzdz != null && !r.peakUnreliable && (minG == null || r.gradBzdz < minG.value)) minG = { value: r.gradBzdz, well, channel: ch };
			if (r.forceIndex != null && !r.peakUnreliable && (minF == null || r.forceIndex < minF.value)) minF = { value: r.forceIndex, well, channel: ch };
		}
	}
	const rowsReported = opts.rowsReported ?? rows.length;
	const rowsMissing = opts.rowsMissing ?? Math.max(0, rowsReported - rows.length);
	return {
		wells,
		wellNumbers,
		channels: [...CHANNELS],
		rowsIngested: rows.length,
		rowsReported,
		goodReported: opts.goodReported ?? rows.length,
		rowsMissing,
		coverage: rowsReported ? rows.length / rowsReported : 1,
		coverageComplete: rowsMissing === 0,
		durationMs: opts.durationMs ?? null,
		minGradient: minG,
		minForceIndex: minF
	};
}
