import { describe, it, expect } from 'vitest';
import { analyzeCartridge, analyzeGroup } from './optical-analysis';

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
