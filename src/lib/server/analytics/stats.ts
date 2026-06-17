/**
 * Statistical helpers for the analytics page. Mix of simple-statistics
 * delegations and hand-rolled domain-specific calcs (control-chart limits,
 * Nelson rules, Cp/Cpk, Pareto).
 */
import * as ss from 'simple-statistics';

// ============================================================================
// Descriptive
// ============================================================================

export interface DescriptiveStats {
	n: number;
	mean: number | null;
	median: number | null;
	stdDev: number | null;
	min: number | null;
	max: number | null;
	q1: number | null;
	q3: number | null;
	iqr: number | null;
	sum: number;
}

export function describe(values: number[]): DescriptiveStats {
	const v = values.filter(x => Number.isFinite(x));
	if (v.length === 0) {
		return { n: 0, mean: null, median: null, stdDev: null, min: null, max: null, q1: null, q3: null, iqr: null, sum: 0 };
	}
	const sorted = [...v].sort((a, b) => a - b);
	const q1 = ss.quantile(sorted, 0.25);
	const q3 = ss.quantile(sorted, 0.75);
	return {
		n: v.length,
		mean: ss.mean(v),
		median: ss.median(v),
		stdDev: v.length > 1 ? ss.standardDeviation(v) : 0,
		min: sorted[0],
		max: sorted[sorted.length - 1],
		q1, q3,
		iqr: q3 - q1,
		sum: ss.sum(v)
	};
}

// ============================================================================
// Histogram
// ============================================================================

export function histogram(values: number[], bins: number = 20): { bins: { start: number; end: number; count: number }[]; min: number; max: number } {
	const v = values.filter(x => Number.isFinite(x));
	if (v.length === 0) return { bins: [], min: 0, max: 0 };
	const min = Math.min(...v);
	const max = Math.max(...v);
	if (min === max) return { bins: [{ start: min, end: max, count: v.length }], min, max };
	const width = (max - min) / bins;
	const out = Array.from({ length: bins }, (_, i) => ({
		start: min + i * width,
		end: min + (i + 1) * width,
		count: 0
	}));
	for (const x of v) {
		const idx = Math.min(bins - 1, Math.floor((x - min) / width));
		out[idx].count++;
	}
	return { bins: out, min, max };
}

// ============================================================================
// Pareto
// ============================================================================

export interface ParetoEntry { label: string; count: number; cumPct: number }

export function paretoFromCounts(counts: Map<string, number> | Record<string, number>): ParetoEntry[] {
	const entries: [string, number][] = counts instanceof Map
		? Array.from(counts.entries())
		: Object.entries(counts);
	const sorted = entries.filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
	const total = sorted.reduce((s, [, n]) => s + n, 0);
	if (total === 0) return [];
	let running = 0;
	return sorted.map(([label, count]) => {
		running += count;
		return { label, count, cumPct: (running / total) * 100 };
	});
}

// ============================================================================
// Capability
// ============================================================================

export interface CapabilityResult {
	cp: number | null;
	cpk: number | null;
	pp: number | null;
	ppk: number | null;
	dpmo: number | null;
	processSigma: number | null;
	centered: boolean;
	warningSmallN: boolean;
	n: number;
	mean: number | null;
	stdDev: number | null;
}

export function capability(values: number[], opts: { LSL?: number | null; USL?: number | null; target?: number | null } = {}): CapabilityResult {
	const { LSL, USL } = opts;
	const v = values.filter(x => Number.isFinite(x));
	const n = v.length;
	if (n < 2) return { cp: null, cpk: null, pp: null, ppk: null, dpmo: null, processSigma: null, centered: false, warningSmallN: true, n, mean: null, stdDev: null };
	const mean = ss.mean(v);
	const stdDev = ss.standardDeviation(v);
	const cp = (LSL != null && USL != null && stdDev > 0) ? (USL - LSL) / (6 * stdDev) : null;
	let cpk: number | null = null;
	if (stdDev > 0) {
		const upper = USL != null ? (USL - mean) / (3 * stdDev) : Infinity;
		const lower = LSL != null ? (mean - LSL) / (3 * stdDev) : Infinity;
		cpk = Math.min(upper, lower);
		if (!Number.isFinite(cpk)) cpk = null;
	}
	// Pp / Ppk use long-term σ — for subgroup-free data, same as Cp/Cpk here
	const pp = cp;
	const ppk = cpk;
	// DPMO + process sigma estimate from cpk
	let dpmo: number | null = null, processSigma: number | null = null;
	if (cpk != null && Number.isFinite(cpk)) {
		const z = cpk * 3;
		// Rough DPMO from normal tail probability × 1M (two-sided)
		const pAbove = 1 - normalCdf(z);
		dpmo = Math.round(pAbove * 2 * 1e6);
		processSigma = z + 1.5; // 1.5σ shift convention
	}
	return {
		cp, cpk, pp, ppk, dpmo, processSigma,
		centered: cp != null && cpk != null && Math.abs(cp - cpk) < 0.05,
		warningSmallN: n < 30,
		n, mean, stdDev
	};
}

// Approx Φ(z) — good enough for DPMO estimation, not for heavy lifting
function normalCdf(z: number): number {
	return 0.5 * (1 + erf(z / Math.SQRT2));
}
function erf(x: number): number {
	const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
	const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
	const sign = x < 0 ? -1 : 1;
	const ax = Math.abs(x);
	const t = 1.0 / (1.0 + p * ax);
	const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
	return sign * y;
}

// ============================================================================
// Control chart — I-MR (individuals + moving range)
// ============================================================================

const D2_MR2 = 1.128; // d2 for moving range of size 2
const D4_MR2 = 3.267;
const D3_MR2 = 0;

export interface IMRChart {
	points: { index: number; value: number; mr: number | null }[];
	centerlineI: number | null;
	uclI: number | null;
	lclI: number | null;
	centerlineMR: number | null;
	uclMR: number | null;
	lclMR: number | null;
	sigma: number | null;
	signals: SpcRuleHit[];
}

export function imrChart(values: number[], labels?: string[]): IMRChart {
	const v = values.filter(x => Number.isFinite(x));
	if (v.length < 2) {
		return {
			points: v.map((x, i) => ({ index: i, value: x, mr: null })),
			centerlineI: v.length ? v[0] : null,
			uclI: null, lclI: null, centerlineMR: null, uclMR: null, lclMR: null,
			sigma: null, signals: []
		};
	}
	const mrs: number[] = [];
	for (let i = 1; i < v.length; i++) mrs.push(Math.abs(v[i] - v[i - 1]));
	const mrBar = ss.mean(mrs);
	const sigma = mrBar / D2_MR2;
	const xbar = ss.mean(v);
	const uclI = xbar + 3 * sigma;
	const lclI = xbar - 3 * sigma;
	const points = v.map((x, i) => ({ index: i, value: x, mr: i > 0 ? mrs[i - 1] : null }));
	const signals = nelsonRules(v, xbar, sigma);
	return {
		points,
		centerlineI: xbar,
		uclI, lclI,
		centerlineMR: mrBar,
		uclMR: D4_MR2 * mrBar,
		lclMR: D3_MR2 * mrBar,
		sigma,
		signals
	};
}

// ============================================================================
// p-chart (proportion defective)
// ============================================================================

export interface PChart {
	points: { index: number; p: number; n: number; ucl: number; lcl: number }[];
	centerline: number;
	signals: SpcRuleHit[];
}

export function pChart(samples: { defects: number; sampleSize: number }[]): PChart {
	const valid = samples.filter(s => s.sampleSize > 0);
	if (valid.length === 0) return { points: [], centerline: 0, signals: [] };
	const totalDef = valid.reduce((s, x) => s + x.defects, 0);
	const totalN = valid.reduce((s, x) => s + x.sampleSize, 0);
	const pBar = totalN > 0 ? totalDef / totalN : 0;
	const points = valid.map((s, i) => {
		const n = s.sampleSize;
		const sigma = Math.sqrt((pBar * (1 - pBar)) / n);
		return {
			index: i,
			p: n > 0 ? s.defects / n : 0,
			n,
			ucl: Math.min(1, pBar + 3 * sigma),
			lcl: Math.max(0, pBar - 3 * sigma)
		};
	});
	const values = points.map(p => p.p);
	const signals = nelsonRules(values, pBar, points.length ? (points[0].ucl - pBar) / 3 : 0);
	return { points, centerline: pBar, signals };
}

// ============================================================================
// Nelson rules (subset, sufficient for Phase 1)
// ============================================================================

export interface SpcRuleHit { ruleNumber: number; description: string; pointIndex: number }

export function nelsonRules(values: number[], centerline: number, sigma: number): SpcRuleHit[] {
	const hits: SpcRuleHit[] = [];
	if (!Number.isFinite(sigma) || sigma <= 0 || values.length === 0) return hits;

	// Rule 1: one point > 3σ from center
	for (let i = 0; i < values.length; i++) {
		if (Math.abs(values[i] - centerline) > 3 * sigma) {
			hits.push({ ruleNumber: 1, description: 'Point beyond 3σ from centerline', pointIndex: i });
		}
	}
	// Rule 2: 9 consecutive on same side
	let streak = 0, sign = 0;
	for (let i = 0; i < values.length; i++) {
		const s = values[i] > centerline ? 1 : values[i] < centerline ? -1 : 0;
		if (s !== 0 && s === sign) streak++;
		else { streak = 1; sign = s; }
		if (streak >= 9) hits.push({ ruleNumber: 2, description: '9 consecutive points on same side of centerline', pointIndex: i });
	}
	// Rule 3: 6 in a row increasing or decreasing
	let inc = 1, dec = 1;
	for (let i = 1; i < values.length; i++) {
		if (values[i] > values[i - 1]) { inc++; dec = 1; } else if (values[i] < values[i - 1]) { dec++; inc = 1; } else { inc = 1; dec = 1; }
		if (inc >= 6 || dec >= 6) hits.push({ ruleNumber: 3, description: '6 consecutive points trending', pointIndex: i });
	}
	// Rule 4: 14 alternating
	let altStreak = 1;
	for (let i = 2; i < values.length; i++) {
		const a = values[i] - values[i - 1];
		const b = values[i - 1] - values[i - 2];
		if ((a > 0 && b < 0) || (a < 0 && b > 0)) altStreak++;
		else altStreak = 1;
		if (altStreak >= 13) hits.push({ ruleNumber: 4, description: '14 alternating points', pointIndex: i });
	}
	// Rule 5: 2 of 3 beyond 2σ same side
	for (let i = 2; i < values.length; i++) {
		const w = [values[i - 2], values[i - 1], values[i]];
		const upper = w.filter(x => x - centerline > 2 * sigma).length;
		const lower = w.filter(x => centerline - x > 2 * sigma).length;
		if (upper >= 2 || lower >= 2) hits.push({ ruleNumber: 5, description: '2 of 3 points beyond 2σ (same side)', pointIndex: i });
	}
	// Rule 6: 4 of 5 beyond 1σ same side
	for (let i = 4; i < values.length; i++) {
		const w = values.slice(i - 4, i + 1);
		const upper = w.filter(x => x - centerline > sigma).length;
		const lower = w.filter(x => centerline - x > sigma).length;
		if (upper >= 4 || lower >= 4) hits.push({ ruleNumber: 6, description: '4 of 5 points beyond 1σ (same side)', pointIndex: i });
	}
	// Rule 7: 15 in a row within 1σ (stratification)
	let withinStreak = 0;
	for (let i = 0; i < values.length; i++) {
		if (Math.abs(values[i] - centerline) < sigma) withinStreak++;
		else withinStreak = 0;
		if (withinStreak >= 15) hits.push({ ruleNumber: 7, description: '15 consecutive points within 1σ (stratification)', pointIndex: i });
	}
	// Rule 8: 8 in a row outside 1σ (mixture)
	let outsideStreak = 0;
	for (let i = 0; i < values.length; i++) {
		if (Math.abs(values[i] - centerline) > sigma) outsideStreak++;
		else outsideStreak = 0;
		if (outsideStreak >= 8) hits.push({ ruleNumber: 8, description: '8 consecutive points outside 1σ (mixture)', pointIndex: i });
	}
	return hits;
}

// ============================================================================
// Hypothesis tests (delegate to simple-statistics)
// ============================================================================

export function oneWayAnova(groups: number[][]): { fStat: number | null; pValue: number | null; dfBetween: number; dfWithin: number; note?: string } {
	const nonEmpty = groups.filter(g => g.filter(x => Number.isFinite(x)).length > 0);
	if (nonEmpty.length < 2) return { fStat: null, pValue: null, dfBetween: 0, dfWithin: 0, note: 'Need ≥2 non-empty groups' };
	const clean = nonEmpty.map(g => g.filter(x => Number.isFinite(x)));
	const grandMean = ss.mean(clean.flat());
	const ssBetween = clean.reduce((s, g) => s + g.length * Math.pow(ss.mean(g) - grandMean, 2), 0);
	const ssWithin = clean.reduce((s, g) => s + g.reduce((t, x) => t + Math.pow(x - ss.mean(g), 2), 0), 0);
	const dfBetween = clean.length - 1;
	const dfWithin = clean.flat().length - clean.length;
	if (dfBetween === 0 || dfWithin === 0) return { fStat: null, pValue: null, dfBetween, dfWithin, note: 'Insufficient degrees of freedom' };
	const msBetween = ssBetween / dfBetween;
	const msWithin = ssWithin / dfWithin;
	if (msWithin === 0) return { fStat: null, pValue: null, dfBetween, dfWithin, note: 'Zero within-group variance' };
	const fStat = msBetween / msWithin;
	const pValue = fApproxP(fStat, dfBetween, dfWithin);
	return { fStat, pValue, dfBetween, dfWithin };
}

// Very rough F-dist approximation. Good enough for "is it significant-ish?"
// Replace with proper F CDF if you need publication-grade accuracy.
function fApproxP(f: number, d1: number, d2: number): number {
	if (f <= 0) return 1;
	const x = (d1 * f) / (d1 * f + d2);
	return 1 - incompleteBeta(x, d1 / 2, d2 / 2);
}
function incompleteBeta(x: number, a: number, b: number): number {
	// Not production-grade — series expansion; clamp extremes.
	if (x <= 0) return 0;
	if (x >= 1) return 1;
	// Approximate via logBeta + continued fraction (standard trick)
	const lbt = Math.log(x) * a + Math.log(1 - x) * b - Math.log(a);
	const bt = Math.exp(lbt);
	return (x < (a + 1) / (a + b + 2))
		? (bt * betaCF(x, a, b)) / 1
		: 1 - (bt * betaCF(1 - x, b, a)) / 1;
}
function betaCF(x: number, a: number, b: number): number {
	let c = 1, d = 1 - ((a + b) * x) / (a + 1);
	if (Math.abs(d) < 1e-30) d = 1e-30;
	d = 1 / d;
	let h = d;
	for (let m = 1; m <= 200; m++) {
		const m2 = 2 * m;
		let aa = (m * (b - m) * x) / ((a - 1 + m2) * (a + m2));
		d = 1 + aa * d;
		if (Math.abs(d) < 1e-30) d = 1e-30;
		c = 1 + aa / c;
		if (Math.abs(c) < 1e-30) c = 1e-30;
		d = 1 / d;
		h *= d * c;
		aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + 1 + m2));
		d = 1 + aa * d;
		if (Math.abs(d) < 1e-30) d = 1e-30;
		c = 1 + aa / c;
		if (Math.abs(c) < 1e-30) c = 1e-30;
		d = 1 / d;
		const delta = d * c;
		h *= delta;
		if (Math.abs(delta - 1) < 3e-7) break;
	}
	return h;
}

// ============================================================================
// Two-sample t-test
// ============================================================================

export function tTest(a: number[], b: number[]): { t: number | null; pValue: number | null; df: number; meanA: number | null; meanB: number | null } {
	const A = a.filter(x => Number.isFinite(x));
	const B = b.filter(x => Number.isFinite(x));
	if (A.length < 2 || B.length < 2) return { t: null, pValue: null, df: 0, meanA: null, meanB: null };
	try {
		const t = ss.tTestTwoSample(A, B) as number;
		const df = A.length + B.length - 2;
		// Approx two-sided p via |t|
		const p = 2 * (1 - studentTApprox(Math.abs(t), df));
		return { t, pValue: p, df, meanA: ss.mean(A), meanB: ss.mean(B) };
	} catch {
		return { t: null, pValue: null, df: 0, meanA: null, meanB: null };
	}
}

function studentTApprox(t: number, df: number): number {
	// Approximation via incomplete beta, normal in limit
	const x = df / (df + t * t);
	return 1 - 0.5 * incompleteBeta(x, df / 2, 0.5);
}

// ============================================================================
// Regression (simple linear)
// ============================================================================

export function linearRegression(xy: [number, number][]): { slope: number; intercept: number; r2: number } | null {
	if (xy.length < 2) return null;
	try {
		const r = ss.linearRegression(xy);
		const line = ss.linearRegressionLine(r);
		const r2 = ss.rSquared(xy, line);
		return { slope: r.m, intercept: r.b, r2 };
	} catch {
		return null;
	}
}

// ============================================================================
// Yield
// ============================================================================

export function fpy(accepted: number, total: number): number {
	return total > 0 ? accepted / total : 0;
}

export function rty(stageYields: number[]): number {
	return stageYields.reduce((a, b) => a * b, 1);
}
