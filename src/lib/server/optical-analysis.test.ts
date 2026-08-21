import { describe, it, expect } from 'vitest';
import {
	analyzeCartridge,
	analyzeGroupRobust,
	compareGroups,
	diffGroups,
	reportGroup,
	robustStats,
	robustZ,
	type GroupInput
} from './optical-analysis';

type Reading = { number: number; channel: 'A' | 'B' | 'C'; f3: number; f7: number };

/** Build readings for one channel: constant f3, an array of f7 values, sequential `number`. */
function channelReadings(
	channel: 'A' | 'B' | 'C',
	f3: number,
	f7s: number[],
	startNumber = 0
): Reading[] {
	return f7s.map((f7, i) => ({ number: startNumber + i, channel, f3, f7 }));
}

/** A cartridge where each channel has `count` readings with constant f3 and constant ratio. */
function flatCartridge(
	ratios: { A: number; B: number; C: number },
	count = 10,
	f3 = 10
): Reading[] {
	const out: Reading[] = [];
	(['A', 'B', 'C'] as const).forEach((ch) => {
		out.push(...channelReadings(ch, f3, Array(count).fill(f3 * ratios[ch])));
	});
	return out;
}

describe('analyzeCartridge', () => {
	it('(a) computes ratio/mode/sd/band + f3/f7 BandStats and honors the endpoint window', () => {
		// Channel A: 12 readings. First 2 are junk (ratio 10) and MUST be excluded by the
		// last-windowK(=10) slice. Last 10 have f3=10 and f7 = six 20s, two 22s, two 18s.
		const aJunk = channelReadings('A', 10, [100, 100], 0); // ratio 10 each
		const aWindow = channelReadings('A', 10, [20, 20, 20, 20, 20, 20, 22, 22, 18, 18], 2);
		// Channels B and C: 10 clean readings, ratio exactly 2.0.
		const b = channelReadings('B', 10, Array(10).fill(20), 0);
		const c = channelReadings('C', 10, Array(10).fill(20), 0);

		const result = analyzeCartridge([...aJunk, ...aWindow, ...b, ...c]);
		expect(result).not.toBeNull();
		const r = result!;

		expect(r.profileName).toBe('Single Scan Cortisol');
		expect(r.windowK).toBe(10);
		expect(typeof r.computedAt).toBe('string');

		const chanA = r.channels.find((x) => x.channel === 'A')!;
		// windowK slicing: 12 readings present but only the LAST 10 used.
		expect(chanA.n).toBe(10);
		// If the two ratio-10 junk readings leaked in, the mean would be far from 2.
		expect(chanA.ratio).toBeCloseTo(2.0, 10);
		expect(chanA.ratioMode).toBe(2.0);
		// sample sd of ratios [2*6, 2.2*2, 1.8*2]: sqrt(0.16/9)
		expect(chanA.ratioSd).toBeCloseTo(Math.sqrt(0.16 / 9), 10);
		expect(chanA.bandLow).toBeCloseTo(2 - Math.sqrt(0.16 / 9), 10);
		expect(chanA.bandHigh).toBeCloseTo(2 + Math.sqrt(0.16 / 9), 10);
		expect(chanA.ratioCv).toBeCloseTo((Math.sqrt(0.16 / 9) / 2) * 100, 10);
		// f3 BandStat: all 10 == 10
		expect(chanA.f3.n).toBe(10);
		expect(chanA.f3.mean).toBeCloseTo(10, 10);
		expect(chanA.f3.sd).toBeCloseTo(0, 10);
		expect(chanA.f3.cv).toBeCloseTo(0, 10);
		// f7 BandStat: mean 20, sd sqrt(16/9)
		expect(chanA.f7.mean).toBeCloseTo(20, 10);
		expect(chanA.f7.sd).toBeCloseTo(Math.sqrt(16 / 9), 10);
		expect(chanA.f7.cv).toBeCloseTo((Math.sqrt(16 / 9) / 20) * 100, 10);
		expect(chanA.flags).toEqual([]);

		// All three channels ratio ~2 -> crossWellCv ~0, no warning.
		expect(r.ratioByChannel.A).toBeCloseTo(2, 10);
		expect(r.ratioByChannel.B).toBeCloseTo(2, 10);
		expect(r.ratioByChannel.C).toBeCloseTo(2, 10);
		expect(r.crossWellCv).toBeCloseTo(0, 10);
		expect(r.rogueChannel).toBeNull();
		expect(r.warning).toBe(false);
		expect(r.channels.map((x) => x.channel)).toEqual(['A', 'B', 'C']);
	});

	it('(b) flags a high-CV channel and a planted z-score outlier', () => {
		// Channel A: ratios [1*5, 3*5] -> CV ~52% (> 15) but max |z| < 2 (no z flag here).
		const a = channelReadings('A', 10, [10, 10, 10, 10, 10, 30, 30, 30, 30, 30]);
		// Channel B: nine ratio-2 readings + one planted ratio-3.5 outlier -> z > 2.
		const b = channelReadings('B', 10, [20, 20, 20, 20, 20, 20, 20, 20, 20, 35]);
		// Channel C: clean.
		const c = channelReadings('C', 10, Array(10).fill(20));

		const r = analyzeCartridge([...a, ...b, ...c])!;
		const chanA = r.channels.find((x) => x.channel === 'A')!;
		const chanB = r.channels.find((x) => x.channel === 'B')!;

		expect(chanA.ratioCv!).toBeGreaterThan(15);
		expect(chanA.flags.some((f) => /CV \d+% > 15%/.test(f))).toBe(true);

		expect(chanB.flags.some((f) => /σ from mean/.test(f))).toBe(true);
		// the planted outlier is reading #9 (0-based within the window)
		expect(chanB.flags.some((f) => /reading #9:/.test(f))).toBe(true);

		expect(r.warning).toBe(true);
		expect(r.reasons.length).toBeGreaterThan(0);
	});

	it('(c) cross-well disagreement sets warning + rogueChannel', () => {
		// A=2, B=2, C=4 -> channels internally consistent (no per-channel flags),
		// cross-well CV ~43% (> 15), rogue = C.
		const readings = flatCartridge({ A: 2, B: 2, C: 4 });
		const r = analyzeCartridge(readings)!;

		expect(r.channels.every((x) => x.flags.length === 0)).toBe(true);
		expect(r.crossWellCv!).toBeGreaterThan(15);
		expect(r.rogueChannel).toBe('C');
		expect(r.warning).toBe(true);
		expect(r.reasons.some((x) => /Channel C is the outlier/.test(x))).toBe(true);
	});

	it('(e) returns null for empty array or non-array', () => {
		expect(analyzeCartridge([])).toBeNull();
		// @ts-expect-error non-array input
		expect(analyzeCartridge(null)).toBeNull();
		// @ts-expect-error non-array input
		expect(analyzeCartridge(undefined)).toBeNull();
	});

	it('(r) ratioSeries carries the per-reading dataset for the endpoint window only', () => {
		// Same fixture as (a): 12 readings on A, the first two (number 0,1) are junk.
		const aJunk = channelReadings('A', 10, [100, 100], 0);
		const aWindow = channelReadings('A', 10, [20, 20, 20, 20, 20, 20, 22, 22, 18, 18], 2);
		const b = channelReadings('B', 10, Array(10).fill(20), 0);
		const c = channelReadings('C', 10, Array(10).fill(20), 0);

		const r = analyzeCartridge([...aJunk, ...aWindow, ...b, ...c])!;
		const chanA = r.channels.find((x) => x.channel === 'A')!;

		expect(chanA.ratioSeries).toHaveLength(10);
		// The junk readings (number 0 and 1, ratio 10) must not appear.
		expect(chanA.ratioSeries.every((p) => p.number >= 2)).toBe(true);
		expect(chanA.ratioSeries.every((p) => p.ratio < 5)).toBe(true);
		// Each point carries its raw bands alongside the derived ratio.
		expect(chanA.ratioSeries[0]).toEqual({ number: 2, f3: 10, f7: 20, ratio: 2 });
	});
});

describe('robustStats', () => {
	it('(f) median (odd + even n), MAD scaling, and robust CV', () => {
		const s = robustStats([1, 2, 3, 4, 5], 3.5);
		expect(s.n).toBe(5);
		expect(s.median).toBe(3);
		// deviations |x-3| = [2,1,0,1,2] -> median 1
		expect(s.mad).toBe(1);
		expect(s.madScaled).toBeCloseTo(1.4826, 10);
		expect(s.scaleEstimator).toBe('mad');
		expect(s.scale).toBeCloseTo(1.4826, 10);
		expect(s.robustCv).toBeCloseTo((1.4826 / 3) * 100, 10);
		expect(s.robustLow).toBeCloseTo(3 - 3.5 * 1.4826, 10);
		expect(s.robustHigh).toBeCloseTo(3 + 3.5 * 1.4826, 10);
		expect(s.q1).toBe(2);
		expect(s.q3).toBe(4);
		expect(s.iqr).toBe(2);
		expect(s.min).toBe(1);
		expect(s.max).toBe(5);
		expect(s.degenerate).toBe(false);
		// classic stats still reported, for display only
		expect(s.mean).toBeCloseTo(3, 10);
		expect(s.sd).toBeCloseTo(Math.sqrt(2.5), 10);

		// even n -> mean of the two middles
		expect(robustStats([1, 2, 3, 4], 3.5).median).toBe(2.5);
	});

	it('(g) MAD=0 falls back to IQR, reports the estimator, and still finds the outlier', () => {
		// >half the values equal the median, so MAD is exactly 0, but q1 != q3.
		const values = [1, 2, 2, 2, 2, 2, 3, 4, 10];
		const s = robustStats(values, 3.5);

		expect(s.median).toBe(2);
		expect(s.mad).toBe(0);
		expect(s.madScaled).toBe(0);
		// Asserting the estimator explicitly: a silent rule-swap is the bug this guards.
		expect(s.scaleEstimator).toBe('iqr');
		expect(s.q1).toBe(2);
		expect(s.q3).toBe(3);
		expect(s.iqr).toBe(1);
		expect(s.scale).toBeCloseTo(1 / 1.349, 10);
		expect(s.degenerate).toBe(false);

		// Without the fallback this would be Infinity for every non-median point.
		expect(robustZ(10, s)!).toBeGreaterThan(3.5);
		expect(Math.abs(robustZ(4, s)!)).toBeLessThan(3.5);
		expect(Math.abs(robustZ(2, s)!)).toBe(0);
	});

	it('(h) fully degenerate input yields no scale, no outliers, and no Infinity/NaN', () => {
		const s = robustStats([2, 2, 2, 2], 3.5);

		expect(s.median).toBe(2);
		expect(s.mad).toBe(0);
		expect(s.iqr).toBe(0);
		expect(s.sd).toBe(0);
		expect(s.scaleEstimator).toBe('none');
		expect(s.scale).toBeNull();
		expect(s.degenerate).toBe(true);
		expect(s.robustLow).toBeNull();
		expect(s.robustHigh).toBeNull();
		expect(s.robustCv).toBeNull();
		// No spread means flagging is impossible, not that everything is an outlier.
		expect(robustZ(99, s)).toBeNull();

		// JSON.stringify turns Infinity/NaN into null, which would blank the UI
		// with no error. Guard against any non-finite number leaking out.
		for (const [key, v] of Object.entries(s)) {
			if (typeof v === 'number') {
				expect(Number.isFinite(v), `${key} must be finite, got ${v}`).toBe(true);
			}
		}
	});

	it('(h2) empty input is handled without throwing', () => {
		const s = robustStats([], 3.5);
		expect(s.n).toBe(0);
		expect(s.median).toBeNull();
		expect(s.scaleEstimator).toBe('none');
		expect(s.degenerate).toBe(true);
		expect(robustZ(1, s)).toBeNull();
	});

	it('(h3) non-finite values are filtered out rather than poisoning the stats', () => {
		const s = robustStats([1, 2, NaN, 3, Infinity, 4, 5], 3.5);
		expect(s.n).toBe(5);
		expect(s.median).toBe(3);
	});
});

/** A group whose cartridges have the given per-well ratios. */
function groupOf(
	groupId: string,
	groupName: string,
	ratios: Array<{ A: number; B: number; C: number }>,
	spuUdi: string | null = null
): GroupInput {
	return {
		groupId,
		groupName,
		items: ratios.map((r, i) => ({
			id: `${groupId}-${i + 1}`,
			spuUdi,
			readings: flatCartridge(r)
		}))
	};
}

/** Shorthand: vary well A, hold B and C flat. */
function groupOnA(groupId: string, name: string, aRatios: number[], spuUdi: string | null = null) {
	return groupOf(
		groupId,
		name,
		aRatios.map((A) => ({ A, B: 2, C: 2 })),
		spuUdi
	);
}

describe('analyzeGroupRobust', () => {
	// The real 7-cartridge group from progress.txt (2026-07-27): six cartridges at
	// ~0.5-0.6 and one at ~8.85 across all three wells.
	const PROGRESS_TXT_GROUP: Array<{ A: number; B: number; C: number }> = [
		{ A: 0.5, B: 0.5, C: 0.5 },
		{ A: 0.52, B: 0.53, C: 0.51 },
		{ A: 0.55, B: 0.54, C: 0.56 },
		{ A: 0.58, B: 0.57, C: 0.59 },
		{ A: 0.6, B: 0.61, C: 0.6 },
		{ A: 0.61, B: 0.6, C: 0.62 },
		{ A: 8.85, B: 8.77, C: 9.49 }
	];

	it('(j) flags exactly the one wild cartridge, and nothing else', () => {
		const { result } = analyzeGroupRobust(groupOf('G', 'SPU-A', PROGRESS_TXT_GROUP));

		expect(result.n).toBe(7);
		expect(result.underpowered).toBe(false);

		const chA = result.channels.find((c) => c.channel === 'A')!;
		expect(chA.median).toBeCloseTo(0.58, 6);
		expect(chA.mad).toBeCloseTo(0.03, 6);
		expect(chA.scaleEstimator).toBe('mad');
		expect(chA.flaggingEnabled).toBe(true);

		const flaggedOnA = result.cartridges.filter((c) => c.outlierChannels.includes('A'));
		expect(flaggedOnA).toHaveLength(1);
		expect(flaggedOnA[0].id).toBe('G-7');

		// Every other cartridge sits well inside the robust band.
		for (const row of result.cartridges) {
			if (row.id === 'G-7') continue;
			expect(Math.abs(row.robustZByChannel.A!)).toBeLessThan(3.5);
		}

		// The reason string is authored server-side so table/plot/CSV cannot diverge.
		expect(flaggedOnA[0].outlierReasons.A).toMatch(/robust SDs above this group's median/);
		expect(flaggedOnA[0].outlierReasons.A).toMatch(/Expected range/);
	});

	it('(k) the spread statistic is the thing that got fixed: classic CV ~180%, robust CV <15%', () => {
		// NOTE for anyone tempted to write the "mean +/- 1SD missed the outlier" story:
		// it did NOT. mean=1.744, sd=3.134, band=[-1.39, 4.88], so 8.85 WAS flagged.
		// What mean/SD got wrong was the SPREAD number — 180% CV, driven entirely by
		// that one member, which made the figure useless for judging the other six.
		const { result } = analyzeGroupRobust(groupOf('G', 'SPU-A', PROGRESS_TXT_GROUP));
		const chA = result.channels.find((c) => c.channel === 'A')!;

		expect(chA.cv!).toBeGreaterThan(100); // the old, useless number
		expect(chA.robustCv!).toBeLessThan(15); // the new, usable one
		expect(result.flags.some((f) => /^Channel A:/.test(f))).toBe(false);
	});

	it('(l) a clean group produces ZERO flags where mean +/- 1SD flagged 2 of 7', () => {
		const clean = [0.5, 0.53, 0.55, 0.57, 0.58, 0.6, 0.63];

		// The retired rule, computed inline rather than by keeping dead code alive:
		// mean +/- 1 sigma leaves ~32% of a normal group outside the band.
		const m = clean.reduce((a, b) => a + b, 0) / clean.length;
		const sd = Math.sqrt(
			clean.reduce((acc, v) => acc + (v - m) * (v - m), 0) / (clean.length - 1)
		);
		const legacyFlagged = clean.filter((v) => v < m - sd || v > m + sd);
		expect(legacyFlagged).toEqual([0.5, 0.63]);

		// New rule: nothing here is an outlier, because nothing here IS an outlier.
		const { result } = analyzeGroupRobust(groupOnA('C', 'Clean', clean));
		expect(result.cartridges.every((c) => c.outlierChannels.length === 0)).toBe(true);
		expect(result.cartridges.every((c) => c.groupOutlier === false)).toBe(true);
	});

	it('(m) survives ~40% contamination without the estimator collapsing', () => {
		const { result } = analyzeGroupRobust(
			groupOnA('M', 'Contaminated', [0.5, 0.52, 0.55, 0.58, 8.8, 8.85, 8.9])
		);
		const flagged = result.cartridges
			.filter((c) => c.outlierChannels.includes('A'))
			.map((c) => c.id);
		expect(flagged).toEqual(['M-5', 'M-6', 'M-7']);
	});

	it('(i) a group below minGroupN is underpowered and flags nothing', () => {
		for (const n of [1, 2, 3, 4]) {
			const { result } = analyzeGroupRobust(
				groupOnA('U', 'Small', [0.5, 0.52, 0.55, 9.9].slice(0, n))
			);
			expect(result.underpowered, `n=${n}`).toBe(true);
			const chA = result.channels.find((c) => c.channel === 'A')!;
			expect(chA.flaggingEnabled, `n=${n}`).toBe(false);
			expect(chA.flaggingDisabledReason, `n=${n}`).toMatch(/too few/);
			expect(result.cartridges.every((c) => c.outlierChannels.length === 0)).toBe(true);
		}
	});

	it('(x) a cartridge with no readings is excluded with a stated reason', () => {
		const g: GroupInput = {
			groupId: 'E',
			groupName: 'Mixed',
			items: [
				{ id: 'E-1', readings: flatCartridge({ A: 0.5, B: 2, C: 2 }) },
				{ id: 'E-2', readings: [] }
			]
		};
		const { result, excluded } = analyzeGroupRobust(g);
		expect(excluded).toHaveLength(1);
		expect(excluded[0].id).toBe('E-2');
		expect(excluded[0].reason).toMatch(/never run/);
		expect(result.cartridges.find((c) => c.id === 'E-2')!.hasReadings).toBe(false);
	});
});

describe('compareGroups', () => {
	it('(n) identical groups: zero difference, bands overlap, separation ~0', () => {
		const vals = [1.9, 1.95, 2.0, 2.05, 2.1];
		const cmp = compareGroups([groupOnA('A', 'SPU-A', vals), groupOnA('B', 'SPU-B', vals)]);

		expect(cmp.groups).toHaveLength(2);
		const d = cmp.deltas.find((x) => x.channel === 'A')!;
		expect(d.medianDiff).toBeCloseTo(0, 10);
		expect(d.medianPctDiff).toBeCloseTo(0, 10);
		expect(d.bandsOverlap).toBe(true);
		expect(d.separation).toBeCloseTo(0, 10);
		expect(d.underpowered).toBe(false);
	});

	it('(o) a 2x offset shows +100% difference, no band overlap, large separation', () => {
		const cmp = compareGroups([
			groupOnA('A', 'SPU-A', [3.8, 3.9, 4.0, 4.1, 4.2]),
			groupOnA('B', 'SPU-B', [1.9, 1.95, 2.0, 2.05, 2.1])
		]);

		const d = cmp.deltas.find((x) => x.channel === 'A')!;
		expect(d.medianA).toBeCloseTo(4, 6);
		expect(d.medianB).toBeCloseTo(2, 6);
		expect(d.medianDiff).toBeCloseTo(2, 6);
		expect(d.medianPctDiff).toBeCloseTo(100, 6);
		expect(d.bandsOverlap).toBe(false);
		expect(d.separation!).toBeGreaterThan(5);
	});

	it('(p) an undersized group marks every delta that touches it as underpowered', () => {
		const cmp = compareGroups([
			groupOnA('A', 'SPU-A', [1.9, 1.95, 2.0, 2.05, 2.1]),
			groupOnA('B', 'Tiny', [2.0, 2.1])
		]);

		expect(cmp.groups.find((g) => g.groupId === 'B')!.underpowered).toBe(true);
		expect(cmp.deltas.every((d) => d.underpowered)).toBe(true);
	});

	it('(q) groups spanning more than one SPU carry the raw-calibration caveat', () => {
		const spanning = compareGroups([
			groupOnA('A', 'SPU-A', [1.9, 1.95, 2.0, 2.05, 2.1], 'BT-M01-0000-0201'),
			groupOnA('B', 'SPU-B', [1.9, 1.95, 2.0, 2.05, 2.1], 'BT-M01-0000-0202')
		]);
		expect(spanning.notes.some((n) => /no per-SPU calibration applied/.test(n))).toBe(true);
		expect(spanning.notes.some((n) => /optics rather than chemistry/.test(n))).toBe(true);

		// Same SPU on both sides -> the confound does not apply, so no caveat.
		const sameSpu = compareGroups([
			groupOnA('A', 'Run 1', [1.9, 1.95, 2.0, 2.05, 2.1], 'BT-M01-0000-0201'),
			groupOnA('B', 'Run 2', [1.9, 1.95, 2.0, 2.05, 2.1], 'BT-M01-0000-0201')
		]);
		expect(sameSpu.notes.some((n) => /no per-SPU calibration applied/.test(n))).toBe(false);
	});

	it('(q2) always states that these are descriptive statistics, not a test', () => {
		const cmp = compareGroups([groupOnA('A', 'SPU-A', [1.9, 2.0, 2.1])]);
		expect(cmp.notes.some((n) => /no p-values are computed/i.test(n))).toBe(true);
	});

	it('(s) the whole comparison survives a JSON round-trip unchanged', () => {
		const cmp = compareGroups([
			groupOnA('A', 'SPU-A', [0.5, 0.52, 0.55, 0.58, 8.85]),
			groupOnA('B', 'SPU-B', [2, 2, 2, 2, 2]) // degenerate on purpose
		]);
		// SvelteKit must serialize this; Infinity/NaN would silently become null.
		expect(JSON.parse(JSON.stringify(cmp))).toEqual(cmp);
	});
});

// ---- VALIDATION-06: reportGroup + diffGroups --------------------------------

/** A cartridge carrying readings ONLY for the wells given a ratio. Omitted wells are absent. */
function partialCartridge(
	ratios: { A?: number; B?: number; C?: number },
	count = 10,
	f3 = 10
): Reading[] {
	const out: Reading[] = [];
	(['A', 'B', 'C'] as const).forEach((ch) => {
		const r = ratios[ch];
		if (r === undefined) return;
		out.push(...channelReadings(ch, f3, Array(count).fill(f3 * r)));
	});
	return out;
}

/** A group where every cartridge has the SAME ratio on all three wells, so the
 *  per-cartridge overall (mean of wells) is exactly that value. */
function groupOnAllWells(
	groupId: string,
	groupName: string,
	values: number[],
	spuUdi: string | null = null
): GroupInput {
	return groupOf(
		groupId,
		groupName,
		values.map((v) => ({ A: v, B: v, C: v })),
		spuUdi
	);
}

/** Walk any structure and assert no non-finite number is hiding in it. */
function assertAllFinite(node: unknown, path = '$'): void {
	if (typeof node === 'number') {
		expect(Number.isFinite(node), `${path} must be finite, got ${node}`).toBe(true);
		return;
	}
	if (Array.isArray(node)) {
		node.forEach((v, i) => assertAllFinite(v, `${path}[${i}]`));
		return;
	}
	if (node !== null && typeof node === 'object') {
		for (const [k, v] of Object.entries(node)) assertAllFinite(v, `${path}.${k}`);
	}
}

describe('reportGroup', () => {
	it('(t1) overall is the mean of the wells that are PRESENT, not of three slots', () => {
		const g: GroupInput = {
			groupId: 'O',
			groupName: 'Overall',
			items: [
				// all three wells: (1 + 2 + 3) / 3 = 2
				{ id: 'O-3wells', readings: partialCartridge({ A: 1, B: 2, C: 3 }) },
				// two wells: (1 + 3) / 2 = 2 — the missing well is SKIPPED, not zero.
				// Zero-filling would have given (1 + 3 + 0)/3 = 1.33.
				{ id: 'O-2wells', readings: partialCartridge({ A: 1, C: 3 }) },
				// one well: the well's own value, unchanged.
				{ id: 'O-1well', readings: partialCartridge({ B: 1.5 }) }
			]
		};

		const rep = reportGroup(g);
		const byId = (id: string) => rep.rows.find((r) => r.id === id)!;

		expect(byId('O-3wells').overallRatio).toBeCloseTo(2, 10);
		expect(byId('O-3wells').wellsUsed).toBe(3);

		expect(byId('O-2wells').overallRatio).toBeCloseTo(2, 10);
		expect(byId('O-2wells').wellsUsed).toBe(2);
		expect(byId('O-2wells').ratioByChannel.B).toBeNull();

		expect(byId('O-1well').overallRatio).toBeCloseTo(1.5, 10);
		expect(byId('O-1well').wellsUsed).toBe(1);
		expect(byId('O-1well').ratioByChannel.B).toBeCloseTo(1.5, 10);

		// Nothing here contributed nothing.
		expect(rep.excluded).toEqual([]);
		expect(rep.n).toBe(3);
	});

	it('(t2) a cartridge with no usable well contributes nothing and is excluded with a reason', () => {
		const g: GroupInput = {
			groupId: 'X',
			groupName: 'Mixed',
			items: [
				{ id: 'X-ok', readings: flatCartridge({ A: 2, B: 2, C: 2 }) },
				{ id: 'X-empty', readings: [] },
				// readings present, but f3 = 0 everywhere so no F7/F3 can be formed
				{ id: 'X-nof3', readings: flatCartridge({ A: 2, B: 2, C: 2 }, 10, 0) }
			]
		};

		const rep = reportGroup(g);

		// Still one row each — a dead cartridge is shown, not silently dropped.
		expect(rep.rows).toHaveLength(3);
		expect(rep.n).toBe(3);

		const empty = rep.rows.find((r) => r.id === 'X-empty')!;
		expect(empty.hasReadings).toBe(false);
		expect(empty.overallRatio).toBeNull();
		expect(empty.wellsUsed).toBe(0);

		const nof3 = rep.rows.find((r) => r.id === 'X-nof3')!;
		expect(nof3.hasReadings).toBe(true);
		expect(nof3.overallRatio).toBeNull();
		expect(nof3.wellsUsed).toBe(0);

		expect(rep.excluded.map((e) => e.id).sort()).toEqual(['X-empty', 'X-nof3']);
		expect(rep.excluded.find((e) => e.id === 'X-empty')!.reason).toMatch(/never run/);
		expect(rep.excluded.find((e) => e.id === 'X-nof3')!.reason).toMatch(/F3 > 0/);
		for (const e of rep.excluded) expect(e.reason.length).toBeGreaterThan(0);

		// Only the one usable cartridge reaches the totals.
		expect(rep.overall.n).toBe(1);
		expect(rep.overall.median).toBeCloseTo(2, 10);
	});

	it('(t3) group totals match a hand-computed fixture', () => {
		// Five cartridges, flat across all wells, at 1 / 2 / 3 / 4 / 5.
		// Per-cartridge overall == that value, so the totals are stats of [1,2,3,4,5]:
		//   mean 3, median 3, sample sd sqrt(2.5), cv sqrt(2.5)/3*100,
		//   deviations |x-3| = [2,1,0,1,2] -> mad 1, madScaled 1.4826.
		const rep = reportGroup(groupOnAllWells('H', 'Hand', [1, 2, 3, 4, 5]));

		expect(rep.groupId).toBe('H');
		expect(rep.groupName).toBe('Hand');
		expect(rep.n).toBe(5);
		expect(rep.windowK).toBe(10);
		expect(rep.rows.map((r) => r.overallRatio)).toEqual([1, 2, 3, 4, 5]);
		expect(rep.rows.every((r) => r.wellsUsed === 3)).toBe(true);

		expect(rep.overall.n).toBe(5);
		expect(rep.overall.mean).toBeCloseTo(3, 10);
		expect(rep.overall.median).toBe(3);
		expect(rep.overall.sd).toBeCloseTo(Math.sqrt(2.5), 10);
		expect(rep.overall.cv).toBeCloseTo((Math.sqrt(2.5) / 3) * 100, 10);
		expect(rep.overall.mad).toBe(1);
		expect(rep.overall.madScaled).toBeCloseTo(1.4826, 10);
		expect(rep.overall.min).toBe(1);
		expect(rep.overall.max).toBe(5);

		// Wells are the same set, so each well matches the overall exactly.
		expect(rep.wells.map((w) => w.channel)).toEqual(['A', 'B', 'C']);
		for (const w of rep.wells) {
			expect(w.n).toBe(5);
			expect(w.mean).toBeCloseTo(3, 10);
			expect(w.median).toBe(3);
			expect(w.sd).toBeCloseTo(Math.sqrt(2.5), 10);
		}
	});

	it('(t4) a report survives a JSON round-trip with no non-finite numbers', () => {
		const rep = reportGroup({
			groupId: 'J',
			groupName: 'Round trip',
			items: [
				...groupOnAllWells('J', 'x', [2, 2, 2, 2, 2]).items, // degenerate on purpose
				{ id: 'J-empty', readings: [] },
				{ id: 'J-nof3', readings: flatCartridge({ A: 1, B: 1, C: 1 }, 10, 0) },
				{ id: 'J-wild', readings: flatCartridge({ A: 8.85, B: 8.77, C: 9.49 }) }
			]
		});

		expect(JSON.parse(JSON.stringify(rep))).toEqual(rep);
		assertAllFinite(rep);
	});
});

describe('diffGroups', () => {
	const SPU_1 = 'BT-M01-0000-0201';
	const SPU_2 = 'BT-M01-0000-0202';

	it('(u1) identical groups produce all-zero differences', () => {
		const vals = [1.9, 1.95, 2.0, 2.05, 2.1];
		const d = diffGroups(groupOnAllWells('A', 'Run 1', vals), groupOnAllWells('B', 'Run 2', vals));

		expect(d.a.groupId).toBe('A');
		expect(d.b.groupId).toBe('B');

		expect(d.overall.avgDiff).toBeCloseTo(0, 12);
		expect(d.overall.avgPctDiff).toBeCloseTo(0, 12);
		expect(d.overall.sdDiff).toBeCloseTo(0, 12);
		expect(d.overall.cvDiffPp).toBeCloseTo(0, 12);
		expect(d.overall.medianDiff).toBeCloseTo(0, 12);
		expect(d.overall.medianPctDiff).toBeCloseTo(0, 12);
		expect(d.overall.underpowered).toBe(false);

		for (const w of d.wells) {
			expect(w.avgDiff, `well ${w.channel}`).toBeCloseTo(0, 12);
			expect(w.cvDiffPp, `well ${w.channel}`).toBeCloseTo(0, 12);
			expect(w.medianDiff, `well ${w.channel}`).toBeCloseTo(0, 12);
		}
		expect(d.wells.map((w) => w.channel)).toEqual(['A', 'B', 'C']);

		// A symmetric comparison must not claim skew.
		expect(d.notes.some((n) => /pulled by an extreme cartridge/.test(n))).toBe(false);
		// ...but must always say it is not a test.
		expect(d.notes.some((n) => /no p-values are computed/i.test(n))).toBe(true);
		expect(d.notes.some((n) => /p-value|t-test|ANOVA/i.test(n) && !/no p-values/i.test(n))).toBe(
			false
		);
	});

	it('(u2) a 2x offset gives avgPctDiff ~= 100', () => {
		const d = diffGroups(
			groupOnAllWells('A', 'High', [3.8, 3.9, 4.0, 4.1, 4.2]),
			groupOnAllWells('B', 'Low', [1.9, 1.95, 2.0, 2.05, 2.1])
		);

		expect(d.a.overall.mean).toBeCloseTo(4, 6);
		expect(d.b.overall.mean).toBeCloseTo(2, 6);
		expect(d.overall.avgDiff).toBeCloseTo(2, 6);
		expect(d.overall.avgPctDiff).toBeCloseTo(100, 6);
		expect(d.overall.medianDiff).toBeCloseTo(2, 6);
		expect(d.overall.medianPctDiff).toBeCloseTo(100, 6);

		// Every well tells the same story, since all wells were offset together.
		for (const w of d.wells) {
			expect(w.avgPctDiff, `well ${w.channel}`).toBeCloseTo(100, 6);
		}
	});

	it('(u3) cvDiffPp is a subtraction of CVs — PERCENTAGE POINTS, not a percent change', () => {
		// A: [90,95,100,105,110] -> mean 100, sd sqrt(62.5), CV 7.9057%
		// B: [98,99,100,101,102] -> mean 100, sd sqrt(2.5),  CV 1.5811%
		const d = diffGroups(
			groupOnAllWells('A', 'Wide', [90, 95, 100, 105, 110]),
			groupOnAllWells('B', 'Tight', [98, 99, 100, 101, 102])
		);

		const cvA = Math.sqrt(62.5); // sd/mean*100 with mean 100
		const cvB = Math.sqrt(2.5);
		expect(d.a.overall.cv).toBeCloseTo(cvA, 8);
		expect(d.b.overall.cv).toBeCloseTo(cvB, 8);

		// pp: 7.9057 - 1.5811 = 6.3246
		expect(d.overall.cvDiffPp).toBeCloseTo(cvA - cvB, 8);
		expect(d.overall.cvDiffPp).toBeCloseTo(6.324555320336759, 8);

		// It is emphatically NOT the relative change, which would be ~400%.
		const relativeChange = ((cvA - cvB) / cvB) * 100;
		expect(relativeChange).toBeGreaterThan(390);
		expect(Math.abs(d.overall.cvDiffPp! - relativeChange)).toBeGreaterThan(300);

		// The means are equal, so a CV difference is the ONLY difference here.
		expect(d.overall.avgDiff).toBeCloseTo(0, 8);
		expect(d.overall.sdDiff).toBeCloseTo(Math.sqrt(62.5) - Math.sqrt(2.5), 8);
	});

	it('(u4) an n=2 group makes every difference underpowered', () => {
		const d = diffGroups(
			groupOnAllWells('A', 'Full', [1.9, 1.95, 2.0, 2.05, 2.1]),
			groupOnAllWells('B', 'Tiny', [2.0, 2.1])
		);

		expect(d.b.overall.n).toBe(2);
		expect(d.overall.underpowered).toBe(true);
		expect(d.wells.every((w) => w.underpowered)).toBe(true);

		// The stats themselves still render — underpowered marks them, it does not blank them.
		expect(d.b.overall.mean).toBeCloseTo(2.05, 10);

		// And the reverse orientation is underpowered too.
		const flipped = diffGroups(
			groupOnAllWells('B', 'Tiny', [2.0, 2.1]),
			groupOnAllWells('A', 'Full', [1.9, 1.95, 2.0, 2.05, 2.1])
		);
		expect(flipped.overall.underpowered).toBe(true);

		// n=5 on both sides is exactly at the limit and is NOT underpowered.
		const ok = diffGroups(
			groupOnAllWells('A', 'Full', [1.9, 1.95, 2.0, 2.05, 2.1]),
			groupOnAllWells('B', 'Also full', [1.9, 1.95, 2.0, 2.05, 2.1])
		);
		expect(ok.overall.underpowered).toBe(false);
	});

	it('(u5) two distinct SPUs emit the raw-F7/F3 calibration caveat', () => {
		const vals = [1.9, 1.95, 2.0, 2.05, 2.1];
		const spanning = diffGroups(
			groupOnAllWells('A', 'SPU-1', vals, SPU_1),
			groupOnAllWells('B', 'SPU-2', vals, SPU_2)
		);
		expect(spanning.notes.some((n) => /no per-SPU calibration applied/.test(n))).toBe(true);
		expect(spanning.notes.some((n) => /optics rather than chemistry/.test(n))).toBe(true);

		// Same SPU on both sides -> the confound does not apply, so no caveat.
		const sameSpu = diffGroups(
			groupOnAllWells('A', 'Run 1', vals, SPU_1),
			groupOnAllWells('B', 'Run 2', vals, SPU_1)
		);
		expect(sameSpu.notes.some((n) => /no per-SPU calibration applied/.test(n))).toBe(false);
		expect(sameSpu.notes.some((n) => /no p-values are computed/i.test(n))).toBe(true);
	});

	it('(u6) a group whose mean is pulled >10% off its median emits the skew note', () => {
		// Skewed: [1,1,1,1,10] -> median 1, mean 2.8 -> 180% divergence.
		// Even:   [1,1.05,1.1,1.15,1.2] -> median 1.1, mean 1.1 -> ~0%.
		const d = diffGroups(
			groupOnAllWells('S', 'Skewed', [1, 1, 1, 1, 10]),
			groupOnAllWells('E', 'Even', [1, 1.05, 1.1, 1.15, 1.2])
		);

		const skew = d.notes.filter((n) => /pulled by an extreme cartridge/.test(n));
		expect(skew).toHaveLength(1);
		expect(skew[0]).toMatch(/Group "Skewed"/);
		expect(skew[0]).toMatch(/CV/);
		// It names the group in trouble, and does not accuse the well-behaved one.
		expect(skew[0]).not.toMatch(/Group "Even"/);

		// A 10%-or-less divergence stays quiet.
		const quiet = diffGroups(
			groupOnAllWells('A', 'Q1', [1, 1.05, 1.1, 1.15, 1.2]),
			groupOnAllWells('B', 'Q2', [2, 2.05, 2.1, 2.15, 2.2])
		);
		expect(quiet.notes.some((n) => /pulled by an extreme cartridge/.test(n))).toBe(false);
	});

	it('(u7) the whole diff survives a JSON round-trip with no non-finite numbers', () => {
		const d = diffGroups(
			{
				groupId: 'A',
				groupName: 'Messy, with a comma',
				items: [
					...groupOnAllWells('A', 'x', [0.5, 0.52, 0.55, 0.58, 8.85], SPU_1).items,
					{ id: 'A-empty', spuUdi: SPU_1, readings: [] },
					{ id: 'A-nof3', spuUdi: SPU_1, readings: flatCartridge({ A: 1, B: 1, C: 1 }, 10, 0) }
				]
			},
			// Fully degenerate AND undersized: every guard at once.
			groupOnAllWells('B', 'Degenerate', [2, 2], SPU_2)
		);

		expect(JSON.parse(JSON.stringify(d))).toEqual(d);
		assertAllFinite(d);

		// A degenerate group has no scale, so its robust fields are null, not Infinity.
		expect(d.b.overall.degenerate).toBe(true);
		expect(d.b.overall.scale).toBeNull();
		expect(d.b.overall.robustCv).toBeNull();
		// The classic mean/median difference is still computable across that boundary.
		expect(d.overall.medianDiff).not.toBeNull();
	});

	it('(u8) a group with nothing usable yields null differences rather than NaN', () => {
		const d = diffGroups(
			groupOnAllWells('A', 'Real', [1.9, 1.95, 2.0, 2.05, 2.1]),
			{
				groupId: 'B',
				groupName: 'All dead',
				items: [
					{ id: 'B-1', readings: [] },
					{ id: 'B-2', readings: [] }
				]
			}
		);

		expect(d.b.overall.n).toBe(0);
		expect(d.b.overall.mean).toBeNull();
		expect(d.overall.avgDiff).toBeNull();
		expect(d.overall.avgPctDiff).toBeNull();
		expect(d.overall.cvDiffPp).toBeNull();
		expect(d.overall.medianDiff).toBeNull();
		expect(d.overall.medianPctDiff).toBeNull();
		expect(d.overall.underpowered).toBe(true);
		expect(d.b.excluded).toHaveLength(2);

		expect(JSON.parse(JSON.stringify(d))).toEqual(d);
		assertAllFinite(d);
	});
});
