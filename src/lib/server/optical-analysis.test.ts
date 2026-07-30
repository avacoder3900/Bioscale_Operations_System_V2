import { describe, it, expect } from 'vitest';
import {
	analyzeCartridge,
	analyzeGroup,
	analyzeGroupRobust,
	compareGroups,
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

		// Old rule, for contrast: ~32% of a normal group falls outside +/-1 sigma.
		const legacy = analyzeGroup(
			clean.map((A, i) => ({ id: `L-${i}`, readings: flatCartridge({ A, B: 2, C: 2 }) }))
		);
		const legacyFlagged = legacy.cartridges.filter((c) => c.outlierChannels.includes('A'));
		expect(legacyFlagged.length).toBe(2);

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

describe('analyzeGroup', () => {
	it('(d) flags a cartridge that is a channel-outlier across the group', () => {
		// Channel A ratios across the 3 cartridges: 2, 2, 5. Mean 3, sd sqrt(3) ~1.732,
		// band [1.27, 4.73] -> cartridge 3 (ratio 5) is outside -> outlier on A.
		// Channels B and C identical across all cartridges (ratio 2) -> no outliers.
		const items = [
			{ id: 'CART-1', readings: flatCartridge({ A: 2, B: 2, C: 2 }) },
			{ id: 'CART-2', label: 'Run 2', readings: flatCartridge({ A: 2, B: 2, C: 2 }) },
			{ id: 'CART-3', readings: flatCartridge({ A: 5, B: 2, C: 2 }) }
		];

		const g = analyzeGroup(items);
		expect(g.n).toBe(3);
		expect(g.windowK).toBe(10);
		expect(g.channels.map((c) => c.channel)).toEqual(['A', 'B', 'C']);

		const rows = Object.fromEntries(g.cartridges.map((c) => [c.id, c]));
		expect(rows['CART-3'].outlierChannels).toContain('A');
		expect(rows['CART-3'].warning).toBe(true);
		expect(rows['CART-1'].warning).toBe(false);
		expect(rows['CART-1'].outlierChannels).toEqual([]);
		// label defaults to id when not provided
		expect(rows['CART-1'].label).toBe('CART-1');
		expect(rows['CART-2'].label).toBe('Run 2');

		// channel A varies a lot across cartridges -> cross-cartridge flag
		expect(g.crossCartridgeFlags.some((f) => /^Channel A:/.test(f))).toBe(true);

		const chA = g.channels.find((c) => c.channel === 'A')!;
		expect(chA.n).toBe(3);
		expect(chA.mean).toBeCloseTo(3, 10);
		expect(chA.sd).toBeCloseTo(Math.sqrt(3), 10);
	});
});
