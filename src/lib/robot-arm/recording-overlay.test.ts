import { describe, it, expect } from 'vitest';
import {
	DEFAULT_OVERLAY_OPTIONS,
	activeSpan,
	alignRecordings,
	alignWith,
	stretchRecordings,
	applyOverlay,
	composeOverlayRecording,
	movingAverage,
	seriesFromFrames,
	validateOverlayOptions,
	type Series
} from './recording-overlay';
import { parseRecording } from './recording-steps';

const RATE = 30;
const POSES = [
	[2000, 900, 3000, 900, 2000, 2100],
	[2300, 700, 2700, 1100, 2000, 2100],
	[2300, 700, 2700, 1100, 2000, 1500],
	[1900, 1000, 3100, 800, 2200, 1500]
];
const minJerk = (u: number) => u * u * u * (10 + u * (-15 + 6 * u));

/** A clean animated path: min-jerk between poses, a hold at each. */
function animated(moveS = 1.5, holdS = 0.6, rate = RATE): Series {
	const t: number[] = [];
	const goal: number[][] = [];
	let tick = 0;
	const push = (row: number[]) => {
		t.push(tick / rate);
		goal.push(row.map(Math.round));
		tick += 1;
	};
	push(POSES[0]);
	for (let p = 1; p < POSES.length; p++) {
		const a = POSES[p - 1];
		const b = POSES[p];
		const n = Math.round(moveS * rate);
		for (let k = 1; k <= n; k++) {
			const u = minJerk(k / n);
			push(a.map((v, i) => v + (b[i] - v) * u));
		}
		for (let k = 0; k < Math.round(holdS * rate); k++) push(b);
	}
	return { t, goal };
}

/**
 * What a pilot would record of the same motion: slower (stretch×), hand
 * tremor, the given offset on every joint, and lead-in / lead-out at other
 * poses that the animation does not have.
 */
function piloted(base: Series, offset: number[], o: { stretch?: number; leadS?: number; tailS?: number; tremor?: number } = {}): Series {
	const stretch = o.stretch ?? 1.7;
	const leadS = o.leadS ?? 2;
	const tailS = o.tailS ?? 1;
	const tremor = o.tremor ?? 4;
	let seed = 7;
	const rnd = () => {
		seed = (seed * 1103515245 + 12345) % 2147483648;
		return seed / 2147483648 - 0.5;
	};
	const t: number[] = [];
	const goal: number[][] = [];
	let tick = 0;
	const push = (row: number[]) => {
		t.push(tick / RATE);
		goal.push(row.map((v) => Math.round(v + rnd() * 2 * tremor)));
		tick += 1;
	};
	const elsewhere = [1500, 1200, 3300, 600, 1800, 2400];
	for (let k = 0; k < leadS * RATE; k++) push(elsewhere);
	const n = base.goal.length;
	const m = Math.round(n * stretch);
	for (let k = 0; k < m; k++) {
		const pos = (k / (m - 1)) * (n - 1);
		const i = Math.min(n - 2, Math.floor(pos));
		const u = pos - i;
		push(base.goal[i].map((v, j) => v + (base.goal[i + 1][j] - v) * u + offset[j]));
	}
	for (let k = 0; k < tailS * RATE; k++) push(elsewhere);
	return { t, goal };
}

const OFFSET = [30, -25, 40, 0, 12, -8];

describe('seriesFromFrames', () => {
	it('carries a missing servo forward and drops frames before every servo is known', () => {
		const s = seriesFromFrames([
			{ t: 0, positions: { '1': 1, '2': 2, '3': 3, '4': 4, '5': 5 } },
			{ t: 0.1, positions: { '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6 } },
			{ t: 0.2, positions: { '1': 9, '3': 3, '4': 4, '5': 5, '6': 6 } }
		]);
		expect(s.t).toEqual([0.1, 0.2]);
		expect(s.goal[1]).toEqual([9, 2, 3, 4, 5, 6]);
	});
});

describe('alignRecordings', () => {
	it('lines a slower, jittery pilot run up with the animation and recovers the per-joint offset', () => {
		const smooth = animated();
		const precise = piloted(smooth, OFFSET);
		const a = alignRecordings(smooth, precise);
		expect(a.every).toBe(1);
		expect(a.match).toHaveLength(smooth.goal.length);
		// Monotonic, and skipping the lead-in / lead-out at the other pose.
		for (let i = 1; i < a.match.length; i++) expect(a.match[i]).toBeGreaterThanOrEqual(a.match[i - 1]);
		expect(a.span.from).toBeGreaterThanOrEqual(2 * RATE - 3);
		expect(a.span.to).toBeLessThanOrEqual(precise.goal.length - 1 * RATE + 3);
		// The fit is about the size of the injected offset vector (≈ 58 steps), not the pose spacing.
		expect(a.fit).toBeLessThan(90);
		const r = applyOverlay(smooth, a, { ...DEFAULT_OVERLAY_OPTIONS, windowS: 0 });
		for (let j = 0; j < 6; j++) expect(Math.abs(r.servos[j].median - OFFSET[j])).toBeLessThanOrEqual(3);
	});

	it('thins long recordings for the warping and still maps every frame', () => {
		const smooth = animated(8, 3); // ~36 s → >1000 frames
		const precise = piloted(smooth, OFFSET, { stretch: 1.3, leadS: 1, tailS: 1 });
		const a = alignRecordings(smooth, precise);
		expect(a.every).toBeGreaterThan(1);
		expect(a.offset).toHaveLength(smooth.goal.length);
		const r = applyOverlay(smooth, a, DEFAULT_OVERLAY_OPTIONS);
		for (let j = 0; j < 6; j++) expect(Math.abs(r.servos[j].median - OFFSET[j])).toBeLessThanOrEqual(4);
	});

	it('refuses a recording with fewer than two frames', () => {
		const smooth = animated();
		expect(() => alignRecordings(smooth, { t: [0], goal: [POSES[0]] })).toThrow(/fewer than 2/);
	});
});

describe('applyOverlay', () => {
	const smooth: Series = { t: [0, 0.1, 0.2, 0.3], goal: [POSES[0], POSES[0], POSES[0], POSES[0]] };
	const offset = [
		[10, -20, 300, 0, 5, 1],
		[10, -20, 300, 0, 5, 1],
		[10, -20, 300, 0, 5, 1],
		[10, -20, 300, 0, 5, 1]
	];

	it('adds the full offset at strength 1, half at 0.5', () => {
		const full = applyOverlay(smooth, { offset }, { ...DEFAULT_OVERLAY_OPTIONS, maxOffset: 1000 });
		expect(full.goal[0]).toEqual([2010, 880, 3300, 900, 2005, 2101]);
		const half = applyOverlay(smooth, { offset }, { ...DEFAULT_OVERLAY_OPTIONS, maxOffset: 1000, strength: 0.5 });
		expect(half.goal[0]).toEqual([2005, 890, 3150, 900, 2003, 2101]);
		expect(half.servos[2].appliedMean).toBe(150);
	});

	it('caps an offset past maxOffset and counts the frames', () => {
		const r = applyOverlay(smooth, { offset }, DEFAULT_OVERLAY_OPTIONS);
		expect(r.goal[0][2]).toBe(3150);
		expect(r.servos[2].capped).toBe(4);
		expect(r.servos[2].max).toBe(300);
		expect(r.servos[0].capped).toBe(0);
	});

	it('leaves servos outside the list on the animation goal', () => {
		const r = applyOverlay(smooth, { offset }, { ...DEFAULT_OVERLAY_OPTIONS, servos: [1, 2] });
		expect(r.goal[0]).toEqual([2010, 880, 3000, 900, 2000, 2100]);
		expect(r.servos[2].corrected).toBe(false);
		expect(r.servos[2].median).toBe(300);
		expect(r.applied[0]).toEqual([10, -20, 0, 0, 0, 0]);
	});

	it('clamps the result to the encoder range', () => {
		const r = applyOverlay({ t: [0, 0.1], goal: [[4090, 0, 0, 0, 0, 0], [4090, 0, 0, 0, 0, 0]] }, { offset: [[100, -100, 0, 0, 0, 0], [100, -100, 0, 0, 0, 0]] }, DEFAULT_OVERLAY_OPTIONS);
		expect(r.goal[0][0]).toBe(4095);
		expect(r.goal[0][1]).toBe(0);
	});

	it('smooths the offset over the window', () => {
		const spiky = [[0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0], [90, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0]];
		const raw = applyOverlay(smooth, { offset: spiky }, { ...DEFAULT_OVERLAY_OPTIONS, windowS: 0 });
		expect(raw.applied.map((r) => r[0])).toEqual([0, 0, 90, 0]);
		const sm = applyOverlay(smooth, { offset: spiky }, { ...DEFAULT_OVERLAY_OPTIONS, windowS: 0.3 }); // 10 Hz → 3 frames
		expect(sm.applied.map((r) => r[0])).toEqual([0, 30, 30, 45]);
	});
});

describe('movingAverage', () => {
	it('is centred and truncates at the edges', () => {
		expect(movingAverage([0, 0, 9, 0, 0], 3)).toEqual([0, 3, 3, 3, 0]);
		expect(movingAverage([1, 2, 3], 1)).toEqual([1, 2, 3]);
	});
});

describe('validateOverlayOptions', () => {
	it('fills defaults and sorts servos', () => {
		expect(validateOverlayOptions({})).toEqual(DEFAULT_OVERLAY_OPTIONS);
		expect(validateOverlayOptions({ servos: ['6', 2, 2], strength: '0.5' }).servos).toEqual([2, 6]);
	});
	it.each([
		[{ strength: 1.5 }, /Strength/],
		[{ windowS: 9 }, /window/],
		[{ maxOffset: 0 }, /Largest offset/],
		[{ servos: [] }, /at least one/],
		[{ servos: [7] }, /1–6/]
	])('rejects %j', (raw, msg) => {
		expect(() => validateOverlayOptions(raw)).toThrow(msg);
	});
});

describe('composeOverlayRecording', () => {
	it('writes a replayable recording with the overlay provenance, times from 0, clamped to the limits', () => {
		const smooth = animated(0.5, 0.2);
		smooth.t = smooth.t.map((t) => t + 5); // a source that did not start at 0
		const goal = smooth.goal.map((row) => row.map((v) => v + 20));
		const out = composeOverlayRecording(smooth.t, goal, {
			smoothHeader: { animated: 'reach', follower_max: [2200, 4095, 4095, 4095, 4095, 4095] },
			smoothName: 'reach.jsonl',
			preciseName: 'pilot-reach.jsonl',
			options: DEFAULT_OVERLAY_OPTIONS,
			jointNames: ['a', 'b', 'c', 'd', 'e', 'f'],
			rateHz: 30
		});
		const parsed = parseRecording(out.jsonl);
		expect(parsed.header?.raw).toMatchObject({ animated: 'reach', rate_hz: 30, overlay: { animated: 'reach.jsonl', pilot: 'pilot-reach.jsonl', strength: 1 } });
		expect(parsed.frames).toHaveLength(smooth.goal.length);
		expect(parsed.frames[0].t).toBe(0);
		expect(Math.max(...parsed.frames.map((f) => f.positions['1']))).toBe(2200);
		expect(parsed.frames[0].positions['2']).toBe(920);
		expect(out.durationS).toBeCloseTo(smooth.t[smooth.t.length - 1] - 5, 3);
	});
});

/** The pilot doing the same moves uniformly slower (or faster), standing still before and after, with tremor. */
function stillThenPiloted(base: Series, offset: number[], o: { stretch: number; leadS: number; tailS: number; tremor?: number }): Series {
	let seed = 11;
	const rnd = () => {
		seed = (seed * 1103515245 + 12345) % 2147483648;
		return seed / 2147483648 - 0.5;
	};
	const tremor = o.tremor ?? 3;
	const t: number[] = [];
	const goal: number[][] = [];
	let tick = 0;
	const push = (row: number[]) => {
		t.push(tick / RATE);
		goal.push(row.map((v, j) => Math.round(v + offset[j] + rnd() * 2 * tremor)));
		tick += 1;
	};
	for (let k = 0; k < o.leadS * RATE; k++) push(base.goal[0]);
	const n = base.goal.length;
	const m = Math.round(n * o.stretch);
	for (let k = 0; k < m; k++) {
		const pos = (k / (m - 1)) * (n - 1);
		const i = Math.min(n - 2, Math.floor(pos));
		push(base.goal[i].map((v, j) => v + (base.goal[i + 1][j] - v) * (pos - i)));
	}
	for (let k = 0; k < o.tailS * RATE; k++) push(base.goal[n - 1]);
	return { t, goal };
}
const spread = (rows: number[][], j: number) => Math.max(...rows.map((r) => r[j])) - Math.min(...rows.map((r) => r[j]));

describe('stretchRecordings', () => {
	it('lays a 1.7x slower pilot run over the animation evenly and recovers the offset', () => {
		const smooth = animated();
		const precise = stillThenPiloted(smooth, OFFSET, { stretch: 1.7, leadS: 2, tailS: 1.5 });
		const a = stretchRecordings(smooth, precise);
		expect(a.mode).toBe('stretch');
		expect(a.stretch).toBeGreaterThan(1.6);
		expect(a.stretch).toBeLessThan(1.8);
		// The still lead-in and tail are skipped; the whole moving part of the pilot is used.
		expect(precise.t[a.span.from]).toBeGreaterThan(1.8);
		expect(precise.t[a.span.to]).toBeLessThan(precise.t[precise.t.length - 1] - 1.3);
		// The amber line moves as far as the grey one (no squeezing).
		for (const j of [0, 1, 2, 3, 5]) expect(spread(a.aligned, j) / spread(smooth.goal, j)).toBeGreaterThan(0.95);
		const r = applyOverlay(smooth, a, { ...DEFAULT_OVERLAY_OPTIONS, windowS: 0 });
		for (let j = 0; j < 6; j++) expect(Math.abs(r.servos[j].median - OFFSET[j])).toBeLessThanOrEqual(4);
		expect(a.fit).toBeLessThan(80);
	});

	it('shrinks a faster pilot run the same way', () => {
		const smooth = animated(2, 1);
		const precise = stillThenPiloted(smooth, OFFSET, { stretch: 0.6, leadS: 1, tailS: 1 });
		const a = stretchRecordings(smooth, precise);
		expect(a.stretch).toBeGreaterThan(0.5);
		expect(a.stretch).toBeLessThan(0.7);
		const r = applyOverlay(smooth, a, { ...DEFAULT_OVERLAY_OPTIONS, windowS: 0 });
		for (let j = 0; j < 6; j++) expect(Math.abs(r.servos[j].median - OFFSET[j])).toBeLessThanOrEqual(4);
	});

	it('without ignoring still time, a pause before the pilot started shifts the whole match', () => {
		const smooth = animated();
		const precise = stillThenPiloted(smooth, OFFSET, { stretch: 1.3, leadS: 4, tailS: 0 });
		const trimmed = stretchRecordings(smooth, precise, { trimIdle: true });
		const whole = stretchRecordings(smooth, precise, { trimIdle: false });
		expect(whole.span.from).toBe(0);
		expect(whole.fit).toBeGreaterThan(trimmed.fit * 2);
	});

	it('alignWith picks the mode', () => {
		const smooth = animated();
		const precise = stillThenPiloted(smooth, OFFSET, { stretch: 1.5, leadS: 1, tailS: 1 });
		expect(alignWith(smooth, precise, { align: 'stretch', trimIdle: true }).mode).toBe('stretch');
		expect(alignWith(smooth, precise, { align: 'follow', trimIdle: true }).mode).toBe('follow');
	});
});

describe('activeSpan', () => {
	it('finds where a recording starts and stops moving', () => {
		const s: Series = { t: [0, 1, 2, 3, 4, 5], goal: [0, 0, 50, 100, 100, 100].map((v) => [v, 0, 0, 0, 0, 0]) };
		// frame 1 = last still frame before the move, frame 3 = first frame at the end pose
		expect(activeSpan(s)).toEqual({ from: 1, to: 3 });
	});
	it('gives the whole recording when nothing moves', () => {
		const s: Series = { t: [0, 1, 2], goal: [POSES[0], POSES[0], POSES[0]] };
		expect(activeSpan(s)).toEqual({ from: 0, to: 2 });
	});
});

describe('validateOverlayOptions (line-up)', () => {
	it('defaults to stretch with still time ignored; reads the form values', () => {
		expect(validateOverlayOptions({})).toMatchObject({ align: 'stretch', trimIdle: true });
		expect(validateOverlayOptions({ align: 'follow', trimIdle: 'false' })).toMatchObject({ align: 'follow', trimIdle: false });
		expect(() => validateOverlayOptions({ align: 'warp' })).toThrow(/stretch/);
	});
});
