import { describe, expect, it } from 'vitest';
import { gradeBenchRead, gradeBenchUnit, gradeBlankRun } from './validation-autograde';
import { fleetSpread, fleetView } from './sonic/fleet';
import type { CompareResult } from './sonic/compare';

/** A full blank run: 42 positions × 3 channels, lasers on (shape of optical_blank_runs.readings). */
function blankRun(over: (r: Record<string, unknown>) => Record<string, unknown> = (r) => r) {
	const rows: Record<string, unknown>[] = [];
	for (let n = 0; n < 42; n++) {
		for (const channel of ['A', 'B', 'C']) {
			rows.push(over({ number: n, channel, f1: 40, f2: 5, f3: 12, f4: 6, f5: 7, f6: 6, f7: 10, f8: 8, clear: 150, nir: 4, laser_output: 780 }));
		}
	}
	return rows;
}

describe('gradeBlankRun', () => {
	it('passes a full run with every laser on', () => {
		const g = gradeBlankRun(blankRun(), 126);
		expect(g.verdict).toBe('pass');
		expect(g.reasons).toEqual([]);
		expect(g.channels.map((c) => c.n)).toEqual([42, 42, 42]);
	});

	it('fails an empty run (the cancelled-run case seen in production)', () => {
		const g = gradeBlankRun([], 0);
		expect(g.verdict).toBe('fail');
		expect(g.reasons[0]).toMatch(/No data/);
	});

	it('fails when one channel’s laser never came on', () => {
		const g = gradeBlankRun(blankRun((r) => (r.channel === 'B' ? { ...r, laser_output: 3 } : r)));
		expect(g.verdict).toBe('fail');
		expect(g.reasons.join(' ')).toMatch(/Channel B: laser did not come on/);
	});

	it('fails a run cut short and a missing channel', () => {
		const g = gradeBlankRun(blankRun().filter((r) => r.channel !== 'C'));
		expect(g.verdict).toBe('fail');
		expect(g.reasons.join(' ')).toMatch(/cut short/);
		expect(g.reasons.join(' ')).toMatch(/Channel C: no readings/);
	});

	it('fails a dead band', () => {
		const g = gradeBlankRun(blankRun((r) => (r.channel === 'A' ? { ...r, f7: 0 } : r)));
		expect(g.reasons).toContain('Channel A: no signal in F7');
	});
});

const ch = (c: string, pd: number, f = [500, 50, 60, 50, 60, 50, 80, 150, 1000, 50]) => ({ c, pd, pd0: 0, f });

describe('gradeBenchRead / gradeBenchUnit', () => {
	const goodLaser = { ch: [ch('A', 780), ch('B', 790), ch('C', 770)] };
	const goodDark = { ch: [ch('A', 0, Array(10).fill(0)), ch('B', 0, Array(10).fill(0)), ch('C', 0, Array(10).fill(0))] };

	it('passes good laser and dark reads; scans are not graded', () => {
		expect(gradeBenchRead('laser', goodLaser)?.verdict).toBe('pass');
		expect(gradeBenchRead('dark', goodDark)?.verdict).toBe('pass');
		expect(gradeBenchRead('laser_scan', {})).toBeNull();
	});

	it('fails a weak laser, a missing channel and light in the dark', () => {
		expect(gradeBenchRead('laser', { ch: [ch('A', 120), ch('B', 790)] })?.reasons).toEqual([
			'Channel A: laser weak or off (photodiode 120, needs ≥ 500)',
			'Channel C: no data'
		]);
		expect(gradeBenchRead('dark', { ch: [ch('A', 400), ch('B', 0), ch('C', 0)] })?.verdict).toBe('fail');
	});

	it('needs both reads for a unit pass', () => {
		expect(gradeBenchUnit({ result: goodLaser }, null).verdict).toBe('incomplete');
		expect(gradeBenchUnit({ result: goodLaser }, { result: goodDark }).verdict).toBe('pass');
		expect(gradeBenchUnit({ result: { error: 'busy' } }, { result: goodDark }).verdict).toBe('fail');
	});
});

describe('fleetSpread', () => {
	// 4 units, 20 bins of 0.5 s → two 5 s intervals. Unit 3 is 10 dB loud in the second.
	const t = Array.from({ length: 20 }, (_, i) => 0.25 + i * 0.5);
	const flat = (v: number) => t.map(() => v);
	const series = [flat(60), flat(60.5), flat(59.5), t.map((tk) => (tk < 5 ? 60 : 70))];

	it('cuts fixed intervals and flags the unit outside mean ± kσ', () => {
		const s = fleetSpread(t, series, { intervalS: 5, k: 1, minInsidePct: 75, unit: 'dB' });
		expect(s.intervals).toHaveLength(2);
		expect(s.intervals[0].inside).toEqual([true, true, true, true]);
		expect(s.intervals[1].inside[3]).toBe(false);
		expect(s.units[3]).toMatchObject({ scored: 2, inside: 1, insidePct: 50, fits: false });
		expect(s.units[0].fits).toBe(true);
		expect(s.units[3].worst?.index).toBe(1);
	});

	it('ignores null bins and needs 2+ units for a σ', () => {
		const s = fleetSpread(t, [flat(60), t.map(() => null)], { intervalS: 5, k: 1, minInsidePct: 75 });
		expect(s.intervals[0].mean).toBeNull();
		expect(s.units[1]).toMatchObject({ scored: 0, fits: null });
	});
});

describe('fleetView shape only', () => {
	it('a unit recorded 8 dB louder with the same shape fits once the level is removed', () => {
		const t = Array.from({ length: 40 }, (_, i) => 0.25 + i * 0.5);
		const curve = (lift: number) => t.map((tk) => 60 + lift + (tk > 10 ? 6 : 0));
		const cmp = { t, series: [0, 0.3, -0.3, 8].map((d) => ({ levelSmooth: curve(d), domHz: t.map(() => null), level: [], active: [] })) } as unknown as CompareResult;
		const opts = { metric: 'loudness' as const, intervalS: 5, k: 1, minInsidePct: 75 };
		expect(fleetView(cmp, { ...opts, shapeOnly: false }).units[3].fits).toBe(false);
		expect(fleetView(cmp, { ...opts, shapeOnly: true }).units[3].fits).toBe(true);
	});
});
