import { describe, it, expect } from 'vitest';
import { computeOpticalAnalysis } from './optical-analysis';

describe('computeOpticalAnalysis', () => {
	it('computes per-channel ratio of sums (f7/f3) for A/B/C', () => {
		const readings = [
			// Channel A: f3 sum = 30, f5 sum = 12, f7 sum = 60 -> f7/f3 = 2
			{ channel: 'A', f3: 10, f5: 5, f7: 20 },
			{ channel: 'A', f3: 20, f5: 7, f7: 40 },
			// Channel B: f3 sum = 8, f5 sum = 6, f7 sum = 24 -> f7/f3 = 3
			{ channel: 'B', f3: 3, f5: 2, f7: 9 },
			{ channel: 'B', f3: 5, f5: 4, f7: 15 },
			// Channel C: f3 sum = 100, f5 sum = 50, f7 sum = 25 -> f7/f3 = 0.25
			{ channel: 'C', f3: 40, f5: 20, f7: 10 },
			{ channel: 'C', f3: 60, f5: 30, f7: 15 }
		];

		const result = computeOpticalAnalysis(readings);
		expect(result).not.toBeNull();
		const r = result!;

		expect(r.profileName).toBe('Single Scan Cortisol');
		expect(r.denominatorColumn).toBe('f3');
		expect(r.ratioNumerators).toEqual(['f5', 'f7']);
		expect(typeof r.computedAt).toBe('string');

		expect(r.ratioByChannel.A).toBeCloseTo(60 / 30, 10);
		expect(r.ratioByChannel.B).toBeCloseTo(24 / 8, 10);
		expect(r.ratioByChannel.C).toBeCloseTo(25 / 100, 10);

		const chanA = r.channels.find((c) => c.channel === 'A')!;
		expect(chanA.n).toBe(2);
		expect(chanA.sums).toEqual({ f3: 30, f5: 12, f7: 60 });
		expect(chanA.ratios['f7/f3']).toBeCloseTo(2, 10);
		expect(chanA.ratios['f5/f3']).toBeCloseTo(12 / 30, 10);
	});

	it('returns null ratios when sumF3 === 0', () => {
		const readings = [
			{ channel: 'A', f3: 0, f5: 5, f7: 20 },
			{ channel: 'A', f3: 0, f5: 7, f7: 40 }
		];

		const result = computeOpticalAnalysis(readings);
		expect(result).not.toBeNull();
		const chanA = result!.channels.find((c) => c.channel === 'A')!;
		expect(chanA.n).toBe(2);
		expect(chanA.sums.f3).toBe(0);
		expect(chanA.ratios['f7/f3']).toBeNull();
		expect(chanA.ratios['f5/f3']).toBeNull();
		expect(result!.ratioByChannel.A).toBeNull();

		// Missing channels get n=0, zero sums, null ratios
		const chanB = result!.channels.find((c) => c.channel === 'B')!;
		expect(chanB.n).toBe(0);
		expect(chanB.sums).toEqual({ f3: 0, f5: 0, f7: 0 });
		expect(chanB.ratios['f7/f3']).toBeNull();
	});

	it('returns null for empty array or non-array', () => {
		expect(computeOpticalAnalysis([])).toBeNull();
		// @ts-expect-error testing non-array input
		expect(computeOpticalAnalysis(null)).toBeNull();
		// @ts-expect-error testing non-array input
		expect(computeOpticalAnalysis(undefined)).toBeNull();
	});

	it('skips non-numeric f-fields but still counts the reading', () => {
		const readings = [
			{ channel: 'A', f3: 10, f5: 'oops', f7: 20 },
			{ channel: 'A', f3: 10, f5: 5, f7: null }
		];
		const result = computeOpticalAnalysis(readings);
		const chanA = result!.channels.find((c) => c.channel === 'A')!;
		expect(chanA.n).toBe(2);
		expect(chanA.sums).toEqual({ f3: 20, f5: 5, f7: 20 });
	});
});
