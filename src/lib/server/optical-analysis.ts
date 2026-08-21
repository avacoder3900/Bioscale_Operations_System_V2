// Optical confirmation analysis — pure, dependency-free, DERIVE-ON-READ only.
// Never writes to the DB. Stats are computed over an ENDPOINT WINDOW = the last
// windowK readings per channel, because readings are a kinetic curve.

export interface OpticalConfig {
	windowK: number;
	cvThreshold: number;
	crossWellCvThreshold: number;
	/** Per-reading, WITHIN a cartridge. Classic z on the sample SD. */
	zThreshold: number;
	/** Per-cartridge, WITHIN a group. Robust z on median/MAD. */
	madThreshold: number;
	/** Below this many cartridges a group is underpowered: no outlier flags. */
	minGroupN: number;
	/** Group spread flag, on robust CV rather than the outlier-sensitive classic CV. */
	robustCvThreshold: number;
}

export const DEFAULT_OPTICAL_CONFIG: OpticalConfig = {
	windowK: 10,
	cvThreshold: 15,
	crossWellCvThreshold: 15,
	zThreshold: 2,
	// 3.5 is the Iglewicz-Hoaglin modified-z cutoff. Because madScaled carries the
	// 1.4826 consistency constant it estimates sigma for normal data, so "3.5 MAD"
	// keeps the same meaning as "3.5 sigma" and stays comparable to zThreshold.
	madThreshold: 3.5,
	// MAD on 3-4 points is not a spread estimate, it is noise.
	minGroupN: 5,
	robustCvThreshold: 15
};

export interface BandStat {
	n: number;
	mean: number;
	sd: number;
	cv: number | null; // PERCENT (sd/mean*100), null if mean===0
}

/** One reading inside the endpoint window, with its F7/F3. The exportable dataset. */
export interface RatioPoint {
	number: number;
	f3: number;
	f7: number;
	ratio: number;
}

/** Which estimator produced `scale`. Surfaced in the UI: silently swapping the
 *  rule is worse than an ugly label. */
export type ScaleEstimator = 'mad' | 'iqr' | 'sd' | 'none';

export interface RobustStat {
	n: number;
	/** Classic stats — DISPLAY ONLY. Never drive a flag off these. */
	mean: number | null;
	sd: number | null;
	cv: number | null;
	bandLow: number | null;
	bandHigh: number | null;
	mode: number | null;
	/** Robust stats — these drive the flags. */
	median: number | null;
	mad: number | null;
	/** 1.4826 * mad — a consistent estimator of sigma for normal data. */
	madScaled: number | null;
	q1: number | null;
	q3: number | null;
	iqr: number | null;
	min: number | null;
	max: number | null;
	/** The dispersion actually used for flagging, per the fallback chain. */
	scale: number | null;
	scaleEstimator: ScaleEstimator;
	/** scale/|median|*100. Reflects the estimator actually used, not always MAD. */
	robustCv: number | null;
	robustLow: number | null;
	robustHigh: number | null;
	/** No usable spread — every value identical. Flagging is impossible, not clean. */
	degenerate: boolean;
}

export interface ChannelAnalysis {
	channel: 'A' | 'B' | 'C';
	n: number;
	windowK: number;
	f3: BandStat;
	f7: BandStat;
	ratio: number | null;
	ratioMode: number | null;
	ratioSd: number | null;
	ratioCv: number | null;
	bandLow: number | null;
	bandHigh: number | null;
	flags: string[];
	/** The per-reading F7/F3 dataset for this well's endpoint window. */
	ratioSeries: RatioPoint[];
}

export interface CartridgeAnalysis {
	profileName: string;
	computedAt: string;
	windowK: number;
	channels: ChannelAnalysis[];
	ratioByChannel: { A: number | null; B: number | null; C: number | null };
	crossWellCv: number | null;
	rogueChannel: 'A' | 'B' | 'C' | null;
	warning: boolean;
	reasons: string[];
}

const CHANNELS: ReadonlyArray<'A' | 'B' | 'C'> = ['A', 'B', 'C'];
const PROFILE_NAME = 'Single Scan Cortisol';

// ---- internal helpers -------------------------------------------------------

function toNum(value: unknown): number | null {
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
}

function mean(values: number[]): number {
	if (values.length === 0) return 0;
	let sum = 0;
	for (const v of values) sum += v;
	return sum / values.length;
}

/** Sample SD (n-1). Returns 0 when fewer than 2 values. */
function sampleSD(values: number[]): number {
	if (values.length < 2) return 0;
	const m = mean(values);
	let acc = 0;
	for (const v of values) acc += (v - m) * (v - m);
	return Math.sqrt(acc / (values.length - 1));
}

/** Percent CV = sd/mean*100. null if mean === 0. */
function cvPercent(m: number, sd: number): number | null {
	return m === 0 ? null : (sd / m) * 100;
}

/** Mode of values binned to 2 decimals (toFixed(2)); ties -> numerically lowest; null if empty. */
function mode(values: number[]): number | null {
	if (values.length === 0) return null;
	const counts = new Map<string, number>();
	for (const v of values) {
		const key = v.toFixed(2);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	let bestKey: string | null = null;
	let bestCount = -1;
	let bestVal = Infinity;
	for (const [key, count] of counts) {
		const val = Number(key);
		if (count > bestCount || (count === bestCount && val < bestVal)) {
			bestCount = count;
			bestVal = val;
			bestKey = key;
		}
	}
	return bestKey === null ? null : Number(bestKey);
}

function bandStat(values: number[]): BandStat {
	const n = values.length;
	const m = mean(values);
	const sd = sampleSD(values);
	return { n, mean: m, sd, cv: cvPercent(m, sd) };
}

/** Median of an already-ascending array. Even n -> mean of the two middles. */
function medianSorted(sorted: number[]): number | null {
	const n = sorted.length;
	if (n === 0) return null;
	const mid = Math.floor(n / 2);
	return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Linear-interpolation quantile (R type 7) on an ascending array. */
function quantileSorted(sorted: number[], p: number): number | null {
	const n = sorted.length;
	if (n === 0) return null;
	if (n === 1) return sorted[0];
	const idx = p * (n - 1);
	const lo = Math.floor(idx);
	const hi = Math.ceil(idx);
	if (lo === hi) return sorted[lo];
	return sorted[lo] + (idx - lo) * (sorted[hi] - sorted[lo]);
}

/** 1/inverse-normal-CDF(0.75) — makes MAD a consistent estimator of sigma. */
const MAD_TO_SIGMA = 1.4826;
/** IQR/1.349 estimates sigma for normal data. */
const IQR_TO_SIGMA = 1.349;

/**
 * Median/MAD-based descriptive statistics for a set of values.
 *
 * Robust rather than mean/SD because a single wild cartridge must not be able to
 * inflate the spread: the 7-cartridge group logged in progress.txt reported a
 * classic CV of 180-205% driven entirely by one member, which made the number
 * useless for judging the other six.
 *
 * MAD = 0 is the trap. With clustered replicates it happens often, and a naive
 * (x - median)/0 gives +/-Infinity for every non-median point -> the whole group
 * flags, and JSON.stringify(Infinity) is null, so the UI silently blanks. Hence
 * the reported fallback chain: mad -> iqr -> sd -> none.
 */
export function robustStats(values: number[], threshold: number): RobustStat {
	const finite = values.filter((v) => Number.isFinite(v));
	const n = finite.length;

	if (n === 0) {
		return {
			n: 0,
			mean: null,
			sd: null,
			cv: null,
			bandLow: null,
			bandHigh: null,
			mode: null,
			median: null,
			mad: null,
			madScaled: null,
			q1: null,
			q3: null,
			iqr: null,
			min: null,
			max: null,
			scale: null,
			scaleEstimator: 'none',
			robustCv: null,
			robustLow: null,
			robustHigh: null,
			degenerate: true
		};
	}

	const sorted = [...finite].sort((a, b) => a - b);
	const med = medianSorted(sorted) as number;

	const m = mean(finite);
	const sd = sampleSD(finite);

	const deviations = finite.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
	const mad = medianSorted(deviations) as number;
	const madScaled = mad * MAD_TO_SIGMA;

	const q1 = quantileSorted(sorted, 0.25);
	const q3 = quantileSorted(sorted, 0.75);
	const iqr = q1 !== null && q3 !== null ? q3 - q1 : null;

	// Fallback chain — report which one was used.
	let scale: number | null = null;
	let scaleEstimator: ScaleEstimator = 'none';
	if (madScaled > 0) {
		scale = madScaled;
		scaleEstimator = 'mad';
	} else if (iqr !== null && iqr > 0) {
		scale = iqr / IQR_TO_SIGMA;
		scaleEstimator = 'iqr';
	} else if (sd > 0) {
		scale = sd;
		scaleEstimator = 'sd';
	}

	const robustCv = scale !== null && med !== 0 ? (scale / Math.abs(med)) * 100 : null;
	const robustLow = scale !== null ? med - threshold * scale : null;
	const robustHigh = scale !== null ? med + threshold * scale : null;

	return {
		n,
		mean: m,
		sd,
		cv: cvPercent(m, sd),
		bandLow: m - sd,
		bandHigh: m + sd,
		mode: mode(finite),
		median: med,
		mad,
		madScaled,
		q1,
		q3,
		iqr,
		min: sorted[0],
		max: sorted[n - 1],
		scale,
		scaleEstimator,
		robustCv,
		robustLow,
		robustHigh,
		degenerate: scaleEstimator === 'none'
	};
}

/** Robust z: (value - median) / scale. null when there is no usable spread. */
export function robustZ(value: number, stat: RobustStat): number | null {
	if (!Number.isFinite(value)) return null;
	if (stat.median === null || stat.scale === null || stat.scale === 0) return null;
	const z = (value - stat.median) / stat.scale;
	return Number.isFinite(z) ? z : null;
}

// ---- per-cartridge ----------------------------------------------------------

export function analyzeCartridge(
	readings: unknown[],
	config?: Partial<OpticalConfig>
): CartridgeAnalysis | null {
	if (!Array.isArray(readings) || readings.length === 0) return null;

	const cfg: OpticalConfig = { ...DEFAULT_OPTICAL_CONFIG, ...config };
	const windowK = cfg.windowK;

	const channels: ChannelAnalysis[] = [];
	const ratioByChannel: { A: number | null; B: number | null; C: number | null } = {
		A: null,
		B: null,
		C: null
	};

	for (const channel of CHANNELS) {
		// filter + sort ascending by (number ?? 0), take last windowK
		const forChannel = readings
			.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
			.filter((r) => (r as Record<string, unknown>).channel === channel)
			.sort((a, b) => (toNum(a.number) ?? 0) - (toNum(b.number) ?? 0));
		const window = forChannel.slice(-windowK);
		const n = window.length;

		const f3Vals: number[] = [];
		const f7Vals: number[] = [];
		const ratioEntries: Array<{ v: number; number: number; f3: number; f7: number }> = [];

		for (const r of window) {
			const f3 = toNum(r.f3);
			const f7 = toNum(r.f7);
			if (f3 !== null) f3Vals.push(f3);
			if (f7 !== null) f7Vals.push(f7);
			if (f3 !== null && f3 > 0 && f7 !== null) {
				const v = f7 / f3;
				if (Number.isFinite(v)) {
					ratioEntries.push({ v, number: toNum(r.number) ?? 0, f3, f7 });
				}
			}
		}

		const series = ratioEntries.map((e) => e.v);
		// The exportable per-reading dataset. Bounded at windowK (10) per well.
		const ratioSeries: RatioPoint[] = ratioEntries.map((e) => ({
			number: e.number,
			f3: e.f3,
			f7: e.f7,
			ratio: e.v
		}));
		const f3Stat = bandStat(f3Vals);
		const f7Stat = bandStat(f7Vals);

		const ratio = series.length > 0 ? mean(series) : null;
		const ratioSd = series.length > 0 ? sampleSD(series) : null;
		const ratioMode = mode(series);
		const ratioCv =
			ratio !== null && ratio !== 0 && ratioSd !== null ? (ratioSd / ratio) * 100 : null;
		const bandLow = ratio !== null && ratioSd !== null ? ratio - ratioSd : null;
		const bandHigh = ratio !== null && ratioSd !== null ? ratio + ratioSd : null;

		const flags: string[] = [];
		if (ratioCv !== null && ratioCv > cfg.cvThreshold) {
			flags.push(`F7/F3 imprecise: CV ${ratioCv.toFixed(0)}% > ${cfg.cvThreshold}%`);
		}
		if (ratio !== null && ratioSd !== null && ratioSd !== 0) {
			for (const e of ratioEntries) {
				const z = (e.v - ratio) / ratioSd;
				if (Math.abs(z) > cfg.zThreshold) {
					flags.push(
						`reading #${e.number}: F7/F3 ${e.v.toFixed(2)} is ${z > 0 ? '+' : ''}${z.toFixed(1)}σ from mean`
					);
				}
			}
		}

		channels.push({
			channel,
			n,
			windowK,
			f3: f3Stat,
			f7: f7Stat,
			ratio,
			ratioMode,
			ratioSd,
			ratioCv,
			bandLow,
			bandHigh,
			flags,
			ratioSeries
		});
		ratioByChannel[channel] = ratio;
	}

	// cross-well
	const finiteRatios = CHANNELS.map((c) => ratioByChannel[c]).filter(
		(v): v is number => v !== null && Number.isFinite(v)
	);
	const crossWellMean = mean(finiteRatios);
	const crossWellSd = sampleSD(finiteRatios);
	const crossWellCv = finiteRatios.length > 0 ? cvPercent(crossWellMean, crossWellSd) : null;

	let rogueChannel: 'A' | 'B' | 'C' | null = null;
	const reasons: string[] = [];
	if (crossWellCv !== null && crossWellCv > cfg.crossWellCvThreshold) {
		// rogue = channel whose ratio is furthest from the mean of the OTHER channels
		let bestDist = -1;
		for (const c of CHANNELS) {
			const rc = ratioByChannel[c];
			if (rc === null || !Number.isFinite(rc)) continue;
			const others = CHANNELS.filter((o) => o !== c)
				.map((o) => ratioByChannel[o])
				.filter((v): v is number => v !== null && Number.isFinite(v));
			if (others.length === 0) continue;
			const dist = Math.abs(rc - mean(others));
			if (dist > bestDist) {
				bestDist = dist;
				rogueChannel = c;
			}
		}
		reasons.push(
			`Channels disagree: F7/F3 varies ${crossWellCv.toFixed(0)}% across A/B/C (limit ${cfg.crossWellCvThreshold}%). Channel ${rogueChannel} is the outlier.`
		);
	}

	for (const ch of channels) {
		for (const f of ch.flags) reasons.push(f);
	}

	const warning =
		channels.some((c) => c.flags.length > 0) ||
		(crossWellCv !== null && crossWellCv > cfg.crossWellCvThreshold);

	return {
		profileName: PROFILE_NAME,
		computedAt: new Date().toISOString(),
		windowK,
		channels,
		ratioByChannel,
		crossWellCv,
		rogueChannel,
		warning,
		reasons
	};
}

// ---- robust group + group-vs-group ------------------------------------------

export interface GroupInputItem {
	id: string;
	label?: string;
	/** The SPU/reader this cartridge ran on, for display and the calibration caveat. */
	spuUdi?: string | null;
	readings: unknown[];
}

export interface GroupInput {
	groupId: string;
	groupName: string;
	items: GroupInputItem[];
}

export interface GroupChannelStat2 extends RobustStat {
	channel: 'A' | 'B' | 'C';
	/** Cartridges in the group. `n` (inherited) is those with a usable ratio HERE. */
	nInGroup: number;
	flaggingEnabled: boolean;
	/** Plain English, rendered verbatim. Never hide why flagging is off. */
	flaggingDisabledReason: string | null;
}

export interface GroupCartridgeRow2 {
	id: string;
	label: string;
	spuUdi: string | null;
	ratioByChannel: { A: number | null; B: number | null; C: number | null };
	robustZByChannel: { A: number | null; B: number | null; C: number | null };
	outlierChannels: Array<'A' | 'B' | 'C'>;
	/** Server-authored sentence per well, so table/plot/CSV cannot diverge. */
	outlierReasons: { A: string | null; B: string | null; C: string | null };
	/** Outlier versus its own group. */
	groupOutlier: boolean;
	/** This cartridge's OWN readings were noisy — a different thing from groupOutlier. */
	cartridgeWarning: boolean;
	cartridgeFlags: string[];
	hasReadings: boolean;
	analysis: CartridgeAnalysis | null;
}

export interface ExcludedCartridge {
	id: string;
	label: string;
	groupId: string;
	groupName: string;
	reason: string;
}

export interface GroupResult {
	groupId: string;
	groupName: string;
	n: number;
	windowK: number;
	underpowered: boolean;
	channels: GroupChannelStat2[];
	cartridges: GroupCartridgeRow2[];
	flags: string[];
}

export interface GroupComparisonDelta {
	channel: 'A' | 'B' | 'C';
	aGroupId: string;
	aGroupName: string;
	nA: number;
	bGroupId: string;
	bGroupName: string;
	nB: number;
	medianA: number | null;
	medianB: number | null;
	/** A - B */
	medianDiff: number | null;
	medianPctDiff: number | null;
	/** Do the two robust bands intersect? */
	bandsOverlap: boolean | null;
	/** |median difference| / pooled robust scale. Descriptive, NOT a test statistic. */
	separation: number | null;
	underpowered: boolean;
}

export interface GroupComparison {
	computedAt: string;
	windowK: number;
	config: OpticalConfig;
	groups: GroupResult[];
	deltas: GroupComparisonDelta[];
	excluded: ExcludedCartridge[];
	notes: string[];
}

const ESTIMATOR_LABEL: Record<ScaleEstimator, string> = {
	mad: 'MAD',
	iqr: 'IQR',
	sd: 'SD',
	none: 'none'
};

function fmtNum(v: number, dp = 2): string {
	return v.toFixed(dp);
}

/**
 * Single-group analysis using the robust median/MAD rule.
 *
 * Differs from the deprecated `analyzeGroup` in three ways: outliers are flagged on
 * median +/- madThreshold*scale rather than mean +/- 1 SD; groups smaller than
 * minGroupN are not flagged at all; and the full per-cartridge CartridgeAnalysis is
 * retained rather than discarded.
 */
export function analyzeGroupRobust(
	group: GroupInput,
	config?: Partial<OpticalConfig>
): { result: GroupResult; excluded: ExcludedCartridge[] } {
	const cfg: OpticalConfig = { ...DEFAULT_OPTICAL_CONFIG, ...config };
	const rows: GroupCartridgeRow2[] = [];
	const excluded: ExcludedCartridge[] = [];

	for (const item of group.items) {
		const analysis = analyzeCartridge(item.readings, cfg);
		const ratioByChannel = analysis
			? analysis.ratioByChannel
			: { A: null, B: null, C: null };
		const label = item.label ?? item.id;

		rows.push({
			id: item.id,
			label,
			spuUdi: item.spuUdi ?? null,
			ratioByChannel,
			robustZByChannel: { A: null, B: null, C: null },
			outlierChannels: [],
			outlierReasons: { A: null, B: null, C: null },
			groupOutlier: false,
			cartridgeWarning: analysis?.warning ?? false,
			cartridgeFlags: analysis ? [...analysis.reasons] : [],
			hasReadings: analysis !== null,
			analysis
		});

		// Say plainly why a cartridge contributes nothing, rather than rendering a
		// bare "—" and still counting it in one of two different n's.
		if (!analysis) {
			excluded.push({
				id: item.id,
				label,
				groupId: group.groupId,
				groupName: group.groupName,
				reason: 'No optical readings on this cartridge — it was never run.'
			});
		} else if (CHANNELS.every((c) => ratioByChannel[c] === null)) {
			excluded.push({
				id: item.id,
				label,
				groupId: group.groupId,
				groupName: group.groupName,
				reason: 'Readings present but no valid F3 > 0, so no F7/F3 could be formed.'
			});
		}
	}

	const underpowered = rows.length < cfg.minGroupN;
	const channels: GroupChannelStat2[] = [];
	const flags: string[] = [];

	for (const c of CHANNELS) {
		const finite = rows
			.map((r) => r.ratioByChannel[c])
			.filter((v): v is number => v !== null && Number.isFinite(v));

		const stat = robustStats(finite, cfg.madThreshold);

		let flaggingEnabled = true;
		let flaggingDisabledReason: string | null = null;
		if (stat.n < cfg.minGroupN) {
			flaggingEnabled = false;
			flaggingDisabledReason =
				`Only ${stat.n} cartridge${stat.n === 1 ? '' : 's'} in this group ` +
				`produced an F7/F3 on well ${c} — too few to tell an outlier from normal ` +
				`spread. At least ${cfg.minGroupN} are needed.`;
		} else if (stat.degenerate) {
			flaggingEnabled = false;
			flaggingDisabledReason =
				`Every cartridge in this group has the same F7/F3 on well ${c} — there is ` +
				`no spread to measure an outlier against.`;
		}

		channels.push({
			...stat,
			channel: c,
			nInGroup: rows.length,
			flaggingEnabled,
			flaggingDisabledReason
		});

		if (flaggingEnabled && stat.median !== null && stat.scale !== null) {
			const estLabel = ESTIMATOR_LABEL[stat.scaleEstimator];
			for (const row of rows) {
				const v = row.ratioByChannel[c];
				if (v === null || !Number.isFinite(v)) continue;
				const z = robustZ(v, stat);
				row.robustZByChannel[c] = z;
				if (z === null || Math.abs(z) <= cfg.madThreshold) continue;

				row.outlierChannels.push(c);
				row.groupOutlier = true;
				row.outlierReasons[c] =
					`F7/F3 ${fmtNum(v)} on well ${c} is ${fmtNum(Math.abs(z), 1)} robust ` +
					`SDs ${z > 0 ? 'above' : 'below'} this group's median of ` +
					`${fmtNum(stat.median)} (flagged beyond ${cfg.madThreshold}; spread ` +
					`estimated from ${estLabel}). Expected range for "${group.groupName}" ` +
					`on well ${c} is ${fmtNum(stat.robustLow!)}–${fmtNum(stat.robustHigh!)}.`;
			}
		} else {
			// Still report z where we can, for the dataset — just do not flag on it.
			for (const row of rows) {
				const v = row.ratioByChannel[c];
				if (v !== null && Number.isFinite(v)) row.robustZByChannel[c] = robustZ(v, stat);
			}
		}

		// Spread flag on ROBUST CV. The classic CV reported 180-205% on a real
		// 7-cartridge group purely because one member was 15x the rest.
		if (stat.robustCv !== null && stat.robustCv > cfg.robustCvThreshold && stat.n > 0) {
			flags.push(
				`Channel ${c}: F7/F3 varies ${stat.robustCv.toFixed(0)}% across the ` +
					`${stat.n} cartridges (robust CV, limit ${cfg.robustCvThreshold}%)`
			);
		}
	}

	return {
		result: {
			groupId: group.groupId,
			groupName: group.groupName,
			n: rows.length,
			windowK: cfg.windowK,
			underpowered,
			channels,
			cartridges: rows,
			flags
		},
		excluded
	};
}

/**
 * Compare N named groups per well.
 *
 * Deliberately DESCRIPTIVE only — median difference, % difference, band overlap and
 * a separation ratio. No p-values, no t-test, no ANOVA. At the group sizes this tool
 * actually sees (n ~ 5-10) there is no power, so a non-significant p would be read
 * as "these SPUs agree" — absence of evidence reported as evidence of absence. The
 * repo's tTest is also pooled-variance (equal-variance assumption, violated the
 * moment one group holds an outlier) and its p-values route through an incompleteBeta
 * that its own source labels not production-grade. If a test is ever wanted, the
 * honest form here is an exact permutation test on the difference of medians.
 */
export function compareGroups(
	groups: GroupInput[],
	config?: Partial<OpticalConfig>
): GroupComparison {
	const cfg: OpticalConfig = { ...DEFAULT_OPTICAL_CONFIG, ...config };

	const results: GroupResult[] = [];
	const excluded: ExcludedCartridge[] = [];
	for (const g of groups) {
		const { result, excluded: ex } = analyzeGroupRobust(g, cfg);
		results.push(result);
		excluded.push(...ex);
	}

	const deltas: GroupComparisonDelta[] = [];
	for (let i = 0; i < results.length; i++) {
		for (let j = i + 1; j < results.length; j++) {
			const A = results[i];
			const B = results[j];
			for (const c of CHANNELS) {
				const sa = A.channels.find((x) => x.channel === c)!;
				const sb = B.channels.find((x) => x.channel === c)!;
				const medianA = sa.median;
				const medianB = sb.median;

				const medianDiff = medianA !== null && medianB !== null ? medianA - medianB : null;
				const medianPctDiff =
					medianDiff !== null && medianB !== null && medianB !== 0
						? (medianDiff / Math.abs(medianB)) * 100
						: null;

				let bandsOverlap: boolean | null = null;
				if (
					sa.robustLow !== null &&
					sa.robustHigh !== null &&
					sb.robustLow !== null &&
					sb.robustHigh !== null
				) {
					bandsOverlap = sa.robustLow <= sb.robustHigh && sb.robustLow <= sa.robustHigh;
				}

				// Pooled robust scale (RMS of the two). Falls back to whichever exists.
				let pooled: number | null = null;
				if (sa.scale !== null && sb.scale !== null) {
					pooled = Math.sqrt((sa.scale * sa.scale + sb.scale * sb.scale) / 2);
				} else if (sa.scale !== null) pooled = sa.scale;
				else if (sb.scale !== null) pooled = sb.scale;

				const separation =
					medianDiff !== null && pooled !== null && pooled > 0
						? Math.abs(medianDiff) / pooled
						: null;

				deltas.push({
					channel: c,
					aGroupId: A.groupId,
					aGroupName: A.groupName,
					nA: sa.n,
					bGroupId: B.groupId,
					bGroupName: B.groupName,
					nB: sb.n,
					medianA,
					medianB,
					medianDiff,
					medianPctDiff,
					bandsOverlap,
					separation,
					underpowered: sa.n < cfg.minGroupN || sb.n < cfg.minGroupN
				});
			}
		}
	}

	const notes: string[] = [];
	const spuUdis = new Set<string>();
	for (const r of results) {
		for (const row of r.cartridges) if (row.spuUdi) spuUdis.add(row.spuUdi);
	}
	// Emitted from the engine, not the template, so the comparison cannot be
	// rendered without the caveat.
	if (spuUdis.size > 1) {
		notes.push(
			'Raw F7/F3, no per-SPU calibration applied. These cartridges ran on ' +
				`${spuUdis.size} different SPUs, so a difference between groups may be ` +
				'optics rather than chemistry.'
		);
	}
	notes.push(
		'Descriptive statistics only — no statistical test is performed and no ' +
			'p-values are computed. Treat flags as review signals, not a pass/fail gate.'
	);

	return {
		computedAt: new Date().toISOString(),
		windowK: cfg.windowK,
		config: cfg,
		groups: results,
		deltas,
		excluded,
		notes
	};
}

// ---- VALIDATION-06: group report + group-vs-group difference ----------------
//
// Additive. `compareGroups`, `analyzeGroupRobust`, `analyzeCartridge` and
// `robustStats` are load-bearing for the shipped /analyze page and are NOT touched.
// Everything below is derive-on-read like the rest of this module: nothing here is
// ever written back to the DB.

/**
 * One cartridge inside a `GroupReport`.
 *
 * `overallRatio` is the MEAN OF THE AVAILABLE WELL RATIOS (A/B/C). Wells that
 * produced no usable F7/F3 are SKIPPED, never treated as zero — a dead well must not
 * drag a cartridge's headline number toward 0. `wellsUsed` records how many of the
 * three actually contributed, so a 1-well number is never mistaken for a 3-well one.
 */
export interface GroupReportRow {
	id: string;
	label: string;
	spuUdi: string | null;
	ratioByChannel: { A: number | null; B: number | null; C: number | null };
	/** Mean of the available well ratios. null when no well produced one. */
	overallRatio: number | null;
	/** How many of A/B/C contributed to `overallRatio` (0-3). */
	wellsUsed: number;
	hasReadings: boolean;
	/** This cartridge's OWN readings were noisy — a different thing from being a group outlier. */
	cartridgeWarning: boolean;
	outlierChannels: Array<'A' | 'B' | 'C'>;
	/**
	 * Server-authored sentence per well, carried through from `analyzeGroupRobust` so
	 * the table, the CSV and any tooltip cannot diverge on why a cell is flagged.
	 */
	outlierReasons: { A: string | null; B: string | null; C: string | null };
}

/** A plain, table-shaped read of one group. Avg / stdev / CV / median all come out of `robustStats`. */
export interface GroupReport {
	groupId: string;
	groupName: string;
	/** Cartridges in the group, INCLUDING any that contributed nothing. */
	n: number;
	windowK: number;
	/** `robustStats` over the per-cartridge `overallRatio` values. */
	overall: RobustStat;
	/** `robustStats` per well, across the group's cartridges. */
	wells: Array<{ channel: 'A' | 'B' | 'C' } & RobustStat>;
	rows: GroupReportRow[];
	excluded: ExcludedCartridge[];
	flags: string[];
}

/**
 * Difference between two `RobustStat`s. Pure subtraction — no test statistic, no
 * p-value, nothing inferential.
 */
export interface StatDiff {
	a: RobustStat | null;
	b: RobustStat | null;
	/** a.mean - b.mean */
	avgDiff: number | null;
	/** `avgDiff` relative to B's mean, in percent. */
	avgPctDiff: number | null;
	/** a.sd - b.sd */
	sdDiff: number | null;
	/**
	 * a.cv - b.cv. CV is ALREADY a percentage, so the difference of two CVs is in
	 * PERCENTAGE POINTS (pp) — not a percentage change. The field, the column header
	 * and the CSV all say "pp" for exactly this reason.
	 */
	cvDiffPp: number | null;
	/** a.median - b.median */
	medianDiff: number | null;
	/** `medianDiff` relative to B's median, in percent. */
	medianPctDiff: number | null;
	/** Either side has fewer than `minGroupN` contributing cartridges. */
	underpowered: boolean;
}

export interface GroupDiffReport {
	computedAt: string;
	windowK: number;
	config: OpticalConfig;
	a: GroupReport;
	b: GroupReport;
	overall: StatDiff;
	wells: Array<{ channel: 'A' | 'B' | 'C' } & StatDiff>;
	/** Emitted FROM THE ENGINE so the view cannot render the numbers without the caveats. */
	notes: string[];
}

/** Mean and median diverging by more than this (percent of |median|) earns the skew note. */
const SKEW_DIVERGENCE_PCT = 10;

/** x - y, null unless both are present and the result is finite. */
function diffOf(x: number | null | undefined, y: number | null | undefined): number | null {
	if (x === null || x === undefined || y === null || y === undefined) return null;
	if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
	const d = x - y;
	return Number.isFinite(d) ? d : null;
}

/** diff/|base|*100. Guarded on base === 0 — an unguarded divide yields Infinity, and
 *  JSON.stringify(Infinity) is null, which blanks the cell with no error anywhere. */
function pctOf(diff: number | null, base: number | null | undefined): number | null {
	if (diff === null || base === null || base === undefined) return null;
	if (!Number.isFinite(base) || base === 0) return null;
	const p = (diff / Math.abs(base)) * 100;
	return Number.isFinite(p) ? p : null;
}

/** Drop the `channel` tag so a StatDiff's `a`/`b` carry a clean RobustStat. */
function bareStat(w: ({ channel: 'A' | 'B' | 'C' } & RobustStat) | undefined | null): RobustStat | null {
	if (!w) return null;
	const { channel, ...rest } = w;
	void channel;
	return rest;
}

/**
 * One group, read as a table: a totals row over the whole group plus one row per
 * cartridge.
 *
 * Thin by construction — `analyzeGroupRobust` (which is itself `analyzeCartridge` per
 * member plus `robustStats` per well) supplies every per-cartridge number and the
 * outlier marks; this adds only the across-well "overall" the compare view needs.
 * No new statistic is invented.
 */
export function reportGroup(group: GroupInput, config?: Partial<OpticalConfig>): GroupReport {
	const cfg: OpticalConfig = { ...DEFAULT_OPTICAL_CONFIG, ...config };

	const { result, excluded } = analyzeGroupRobust(group, cfg);

	const rows: GroupReportRow[] = [];
	const overallValues: number[] = [];

	for (const row of result.cartridges) {
		// Skip, do not zero-fill. A well with no usable ratio contributes nothing.
		const used: number[] = [];
		for (const c of CHANNELS) {
			const v = row.ratioByChannel[c];
			if (v !== null && Number.isFinite(v)) used.push(v);
		}
		const rawOverall = used.length > 0 ? mean(used) : null;
		const overallRatio = rawOverall !== null && Number.isFinite(rawOverall) ? rawOverall : null;
		if (overallRatio !== null) overallValues.push(overallRatio);

		rows.push({
			id: row.id,
			label: row.label,
			spuUdi: row.spuUdi,
			ratioByChannel: { ...row.ratioByChannel },
			overallRatio,
			wellsUsed: used.length,
			hasReadings: row.hasReadings,
			cartridgeWarning: row.cartridgeWarning,
			outlierChannels: [...row.outlierChannels],
			outlierReasons: { ...row.outlierReasons }
		});
	}

	const overall = robustStats(overallValues, cfg.madThreshold);

	const wells = CHANNELS.map((c) => {
		const vals = rows
			.map((r) => r.ratioByChannel[c])
			.filter((v): v is number => v !== null && Number.isFinite(v));
		return { channel: c, ...robustStats(vals, cfg.madThreshold) };
	});

	const flags = [...result.flags];
	// Same rule as the per-well spread flag, applied to the overall — robust CV, not
	// the outlier-sensitive classic CV.
	if (overall.n > 0 && overall.robustCv !== null && overall.robustCv > cfg.robustCvThreshold) {
		flags.push(
			`Overall F7/F3 varies ${overall.robustCv.toFixed(0)}% across the ${overall.n} ` +
				`cartridge${overall.n === 1 ? '' : 's'} with a usable value (robust CV, limit ` +
				`${cfg.robustCvThreshold}%)`
		);
	}

	// Backstop: anything with no usable well must be accounted for out loud, never
	// silently absent from both the totals and the excluded list.
	const excludedOut = [...excluded];
	for (const r of rows) {
		if (r.overallRatio !== null) continue;
		if (excludedOut.some((e) => e.id === r.id)) continue;
		excludedOut.push({
			id: r.id,
			label: r.label,
			groupId: group.groupId,
			groupName: group.groupName,
			reason: 'No well produced a usable F7/F3, so this cartridge has no overall value.'
		});
	}

	return {
		groupId: group.groupId,
		groupName: group.groupName,
		n: rows.length,
		windowK: cfg.windowK,
		overall,
		wells,
		rows,
		excluded: excludedOut,
		flags
	};
}

function statDiff(a: RobustStat | null, b: RobustStat | null, minGroupN: number): StatDiff {
	const avgDiff = diffOf(a?.mean, b?.mean);
	const medianDiff = diffOf(a?.median, b?.median);
	return {
		a: a ?? null,
		b: b ?? null,
		avgDiff,
		avgPctDiff: pctOf(avgDiff, a && b ? b.mean : null),
		sdDiff: diffOf(a?.sd, b?.sd),
		cvDiffPp: diffOf(a?.cv, b?.cv),
		medianDiff,
		medianPctDiff: pctOf(medianDiff, a && b ? b.median : null),
		underpowered: (a?.n ?? 0) < minGroupN || (b?.n ?? 0) < minGroupN
	};
}

/**
 * When a group's mean is pulled well off its median, say so. This is the whole point
 * of showing median next to avg, and it should be stated rather than left for the
 * reader to notice.
 */
function skewNote(report: GroupReport): string | null {
	const m = report.overall.mean;
	const med = report.overall.median;
	if (m === null || med === null) return null;
	if (!Number.isFinite(m) || !Number.isFinite(med) || med === 0) return null;
	const divergence = (Math.abs(m - med) / Math.abs(med)) * 100;
	if (!Number.isFinite(divergence) || divergence <= SKEW_DIVERGENCE_PCT) return null;
	return (
		`Group "${report.groupName}": the average F7/F3 (${fmtNum(m)}) sits ` +
		`${divergence.toFixed(0)}% away from the median (${fmtNum(med)}). The average is being ` +
		`pulled by an extreme cartridge, so read this group's CV with that in mind — the median ` +
		`is the more representative centre here.`
	);
}

/**
 * Group A versus Group B, as a difference of descriptive statistics.
 *
 * Calls `reportGroup` twice and subtracts. Deliberately DESCRIPTIVE only — no
 * p-values, no t-test, no ANOVA, for the reasons set out above `compareGroups`.
 * At n ~ 5-10 there is no power, and a non-significant p would be read as "these
 * groups agree", i.e. absence of evidence reported as evidence of absence.
 */
export function diffGroups(
	a: GroupInput,
	b: GroupInput,
	config?: Partial<OpticalConfig>
): GroupDiffReport {
	const cfg: OpticalConfig = { ...DEFAULT_OPTICAL_CONFIG, ...config };

	const ra = reportGroup(a, cfg);
	const rb = reportGroup(b, cfg);

	const overall = statDiff(ra.overall, rb.overall, cfg.minGroupN);

	const wells = CHANNELS.map((c) => {
		const wa = bareStat(ra.wells.find((w) => w.channel === c));
		const wb = bareStat(rb.wells.find((w) => w.channel === c));
		return { channel: c, ...statDiff(wa, wb, cfg.minGroupN) };
	});

	// Notes come from the engine, not the template, so the comparison cannot be
	// rendered without its caveats.
	const notes: string[] = [];

	const spuUdis = new Set<string>();
	for (const r of [ra, rb]) {
		for (const row of r.rows) if (row.spuUdi) spuUdis.add(row.spuUdi);
	}
	if (spuUdis.size > 1) {
		notes.push(
			'Raw F7/F3, no per-SPU calibration applied. These cartridges ran on ' +
				`${spuUdis.size} different SPUs, so a difference between groups may be ` +
				'optics rather than chemistry.'
		);
	}

	notes.push(
		'Descriptive statistics only — no statistical test is performed and no ' +
			'p-values are computed. Treat a difference as a review signal, not a pass/fail gate.'
	);

	for (const r of [ra, rb]) {
		const note = skewNote(r);
		if (note) notes.push(note);
	}

	return {
		computedAt: new Date().toISOString(),
		windowK: cfg.windowK,
		config: cfg,
		a: ra,
		b: rb,
		overall,
		wells,
		notes
	};
}
