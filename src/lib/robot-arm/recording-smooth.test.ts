import { describe, it, expect } from 'vitest';
import {
	DEFAULT_SMOOTH_OPTIONS,
	SMOOTHING_OFF,
	composeSmoothedRecording,
	findStops,
	smoothSeries,
	validateSmoothOptions,
	type Series
} from './recording-smooth';
import { parseRecording } from './recording-steps';

const RATE = 30;
const A = [2000, 900, 3000, 900, 2000, 2100];
const B = [2400, 700, 2700, 1100, 2000, 2100];

/** Hold A, a shaky linear move to B, hold B (with hand tremor everywhere). */
function teleop(o: { holdS?: number; moveS?: number; tremor?: number } = {}): Series {
	const holdS = o.holdS ?? 1;
	const moveS = o.moveS ?? 1.5;
	const tremor = o.tremor ?? 4;
	let seed = 5;
	const rnd = () => {
		seed = (seed * 1103515245 + 12345) % 2147483648;
		return seed / 2147483648 - 0.5;
	};
	const t: number[] = [];
	const goal: number[][] = [];
	let k = 0;
	const push = (row: number[], jitter: number) => {
		t.push(k / RATE);
		goal.push(row.map((v) => Math.round(v + rnd() * 2 * jitter)));
		k++;
	};
	for (let i = 0; i < holdS * RATE; i++) push(A, tremor);
	const n = moveS * RATE;
	for (let i = 1; i <= n; i++) push(A.map((v, j) => v + ((B[j] - v) * i) / n), tremor * 3);
	for (let i = 0; i < holdS * RATE; i++) push(B, tremor);
	return { t, goal };
}

/** Largest frame-to-frame change in frame-to-frame change: how jerky a lane is. */
function roughness(goal: number[][], j: number): number {
	let r = 0;
	for (let i = 2; i < goal.length; i++) r = Math.max(r, Math.abs(goal[i][j] - 2 * goal[i - 1][j] + goal[i - 2][j]));
	return r;
}

describe('findStops', () => {
	it('finds the two holds of a teleop move, not the move', () => {
		const s = teleop();
		const stops = findStops(s);
		expect(stops).toHaveLength(2);
		expect(stops[0].from).toBe(0);
		expect(stops[0].to).toBeGreaterThanOrEqual(RATE - 3);
		expect(stops[1].to).toBe(s.goal.length - 1);
		expect(s.t[stops[1].from]).toBeLessThan(2.6);
	});
	it('a hold shorter than the minimum is not a stop', () => {
		expect(findStops(teleop({ holdS: 0.2 }))).toHaveLength(0);
	});
});

describe('smoothSeries', () => {
	it('takes the tremor out of the move and pins each stop to where the pilot held', () => {
		const s = teleop();
		const r = smoothSeries(s, DEFAULT_SMOOTH_OPTIONS);
		for (const j of [0, 1, 2, 3]) expect(roughness(r.goal, j)).toBeLessThan(roughness(s.goal, j) / 3);
		// Stops are flat at (about) the held pose: tremor ±4 has median ≈ pose.
		const first = r.goal.slice(0, 15).map((row) => row[0]);
		expect(new Set(first).size).toBe(1);
		expect(Math.abs(first[0] - A[0])).toBeLessThanOrEqual(2);
		const last = r.goal.slice(-12).map((row) => row[1]);
		expect(new Set(last).size).toBe(1);
		expect(Math.abs(last[0] - B[1])).toBeLessThanOrEqual(2);
		// The first and last frames sit in stops here, so they take the hold's median: a few steps of tremor away.
		for (let j = 0; j < 6; j++) {
			expect(Math.abs(r.goal[0][j] - s.goal[0][j])).toBeLessThanOrEqual(6);
			expect(Math.abs(r.goal[r.goal.length - 1][j] - s.goal[s.goal.length - 1][j])).toBeLessThanOrEqual(6);
		}
		expect(r.stops).toHaveLength(2);
		expect(r.peakSpeed).toBeLessThan(r.sourcePeakSpeed);
	});

	it('strength 0 is the source; 0.5 is half way', () => {
		const s = teleop();
		expect(smoothSeries(s, { ...DEFAULT_SMOOTH_OPTIONS, strength: 0 }).goal).toEqual(s.goal);
		const full = smoothSeries(s, DEFAULT_SMOOTH_OPTIONS);
		const half = smoothSeries(s, { ...DEFAULT_SMOOTH_OPTIONS, strength: 0.5 });
		const i = 45;
		expect(Math.abs(half.goal[i][0] - (s.goal[i][0] + full.goal[i][0]) / 2)).toBeLessThanOrEqual(1);
	});

	it('leaves unticked servos on the source and window 0 only pins the stops', () => {
		const s = teleop();
		const r = smoothSeries(s, { ...DEFAULT_SMOOTH_OPTIONS, servos: [1] });
		expect(r.goal.map((row) => row[1])).toEqual(s.goal.map((row) => row[1]));
		expect(r.servos[1].smoothed).toBe(false);
		const w0 = smoothSeries(s, { ...DEFAULT_SMOOTH_OPTIONS, windowS: 0 });
		expect(w0.goal[40]).toEqual(s.goal[40]); // mid-move frame untouched
		expect(new Set(w0.goal.slice(2, 25).map((row) => row[0])).size).toBe(1); // hold flattened
	});

	it('without keepStops the holds are averaged, not pinned flat', () => {
		const r = smoothSeries(teleop(), { ...DEFAULT_SMOOTH_OPTIONS, keepStops: false });
		expect(r.stops).toHaveLength(0);
	});
});

describe('validateSmoothOptions', () => {
	it('fills from the fallback and reads form values', () => {
		expect(validateSmoothOptions({})).toEqual(DEFAULT_SMOOTH_OPTIONS);
		expect(validateSmoothOptions(undefined, SMOOTHING_OFF).enabled).toBe(false);
		expect(validateSmoothOptions({ enabled: 'on', windowS: '1.25', servos: ['3', 1] })).toMatchObject({ enabled: true, windowS: 1.3, servos: [1, 3] });
	});
	it.each([
		[{ source: 'x' }, /source/],
		[{ windowS: 4 }, /window/],
		[{ strength: 2 }, /strength/],
		[{ servos: [] }, /at least one/],
		[{ servos: [9] }, /1–6/]
	])('rejects %j', (raw, msg) => {
		expect(() => validateSmoothOptions(raw)).toThrow(msg);
	});
	it('no servos is fine while smoothing is off', () => {
		expect(validateSmoothOptions({ enabled: false, servos: [] }).servos).toEqual([]);
	});
});

describe('composeSmoothedRecording', () => {
	it('writes a replayable recording with the smoothing provenance, from t = 0', () => {
		const s = teleop();
		s.t = s.t.map((x) => x + 3);
		const r = smoothSeries(s, DEFAULT_SMOOTH_OPTIONS);
		const out = composeSmoothedRecording(s.t, r.goal, {
			header: { follower_max: [2300, 4095, 4095, 4095, 4095, 4095] },
			sourceName: 'pilot.jsonl',
			options: DEFAULT_SMOOTH_OPTIONS,
			jointNames: ['a', 'b', 'c', 'd', 'e', 'f'],
			rateHz: 30,
			cleanupId: 'c1'
		});
		const p = parseRecording(out.jsonl);
		expect(p.header?.raw).toMatchObject({ cleaned_from: 'pilot.jsonl', cleanup_id: 'c1', smoothed: { source: 'recording', window_s: 0.6 } });
		expect(p.frames[0].t).toBe(0);
		expect(p.frames).toHaveLength(s.goal.length);
		expect(Math.max(...p.frames.map((f) => f.positions['1']))).toBe(2300);
	});
});
