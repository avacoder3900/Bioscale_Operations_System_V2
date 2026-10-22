import { describe, expect, it } from 'vitest';
import {
	autoDurationS,
	buildPath,
	cleanKeyframes,
	cleanOffsets,
	composeAnimationJsonl,
	ease,
	estimateTrim,
	flattenSequence,
	jogChunks,
	keyframePositions,
	minDurationS,
	nextTrim,
	pathStats,
	settleFrames,
	tooFast,
	trimFromSettle,
	MAX_STEPS_PER_S,
	MAX_TRIM_STEPS,
	type ResolvedKeyframe
} from './animation';

const A = [2048, 1500, 2600, 2048, 2100, 1800];
const B = [2348, 1700, 2400, 2048, 2100, 1800];
const C = [2648, 1900, 2200, 2248, 2300, 2100];

function kf(name: string, positions: number[], o: Partial<ResolvedKeyframe> = {}): ResolvedKeyframe {
	return { poseId: name, name, positions, holdS: 0, durationS: 1, easing: 'ease', ...o };
}

const speeds = (goal: number[][], rate: number, s: number) => goal.slice(1).map((g, i) => (g[s] - goal[i][s]) * rate);

describe('easing', () => {
	it('every easing goes 0 → 1 and stays inside', () => {
		for (const e of ['ease', 'linear', 'in', 'out', 'flow'] as const) {
			expect(ease(e, 0)).toBe(0);
			expect(ease(e, 1)).toBe(1);
			expect(ease(e, 0.5)).toBeGreaterThan(0);
			expect(ease(e, 0.5)).toBeLessThan(1);
		}
		expect(ease('ease', 0.5)).toBeCloseTo(0.5, 9);
		expect(ease('in', 0.5)).toBeLessThan(0.5);
		expect(ease('out', 0.5)).toBeGreaterThan(0.5);
	});
});

describe('durations', () => {
	it('minimum duration comes from the fastest servo at the easing\'s peak speed', () => {
		expect(minDurationS(A, A)).toBe(0);
		expect(minDurationS(A, B, MAX_STEPS_PER_S, 'linear')).toBe(0.2); // 300 steps / 2000 → 0.15 → floor 0.2
		expect(minDurationS(A, B)).toBe(0.3); // easy ease peaks at 1.875× average: 0.28 → 0.3
		expect(minDurationS(A, B, MAX_STEPS_PER_S, 'in')).toBe(0.5); // cubic peaks at 3×: 0.45 → 0.5
		expect(minDurationS(A, [A[0] + 4000, ...A.slice(1)], MAX_STEPS_PER_S, 'linear')).toBe(2);
		expect(minDurationS(A, [A[0] + 4000, ...A.slice(1)])).toBe(3.8);
	});
	it('a path rendered at the minimum duration is not refused by pathStats', () => {
		const far = [A[0] + 1500, ...A.slice(1)];
		for (const easing of ['ease', 'linear', 'in', 'out'] as const) {
			const d = minDurationS(A, far, MAX_STEPS_PER_S, easing);
			expect(pathStats(buildPath([kf('A', A), kf('far', far, { durationS: d, easing })], { rateHz: 30 })).tooFast).toEqual([]);
		}
	});
	it('auto duration is comfortable, not fast', () => {
		expect(autoDurationS(A, B)).toBe(0.5); // 300 / 600
	});
	it('cleanKeyframes rejects bad input and defaults the easing', () => {
		expect(cleanKeyframes([{ poseId: 'p', holdS: 1.26, durationS: 2, easing: 'bogus' }])).toEqual([{ poseId: 'p', holdS: 1.3, durationS: 2, easing: 'ease' }]);
		expect(() => cleanKeyframes([{ poseId: '', durationS: 1 }])).toThrow(/no pose/);
		expect(() => cleanKeyframes([{ poseId: 'p', durationS: 0.05 }])).toThrow(/duration/);
	});
});

describe('buildPath', () => {
	it('one segment with easy ease: starts at A, ends exactly at B, settles (slow at both ends)', () => {
		const p = buildPath([kf('A', A), kf('B', B, { durationS: 2 })], { rateHz: 30 });
		expect(p.goal[0]).toEqual(A);
		expect(p.goal[p.goal.length - 1]).toEqual(B);
		expect(p.durationS).toBe(2);
		expect(p.t.length).toBe(61);
		const v = speeds(p.goal, 30, 0);
		expect(Math.abs(v[0])).toBeLessThan(Math.abs(v[30]));
		expect(Math.abs(v[v.length - 1])).toBeLessThan(Math.abs(v[30]));
		// monotone on the servo that moves
		for (let i = 1; i < p.goal.length; i++) expect(p.goal[i][0]).toBeGreaterThanOrEqual(p.goal[i - 1][0]);
	});

	it('a hold keeps the pose flat for its whole length', () => {
		const p = buildPath([kf('A', A), kf('B', B, { durationS: 1, holdS: 1 }), kf('C', C, { durationS: 1 })], { rateHz: 10 });
		expect(p.durationS).toBe(3);
		for (let i = 10; i <= 20; i++) expect(p.goal[i]).toEqual(B);
		expect(p.markers.map((m) => m.t)).toEqual([0, 1, 3]);
	});

	it('flow carries velocity through the middle pose; ease stops there', () => {
		const stop = buildPath([kf('A', A), kf('B', B, { durationS: 1 }), kf('C', C, { durationS: 1 })], { rateHz: 30 });
		const flow = buildPath([kf('A', A), kf('B', B, { durationS: 1, easing: 'flow' }), kf('C', C, { durationS: 1, easing: 'flow' })], { rateHz: 30 });
		const vStop = speeds(stop.goal, 30, 0);
		const vFlow = speeds(flow.goal, 30, 0);
		// frame 30 is the arrival at B
		expect(Math.abs(vStop[29])).toBeLessThan(40);
		expect(Math.abs(vFlow[29])).toBeGreaterThan(200);
		expect(flow.goal[30]).toEqual(B); // still passes exactly through the pose
		expect(flow.goal[flow.goal.length - 1]).toEqual(C);
	});

	it('a lead-in starts where the arm is and tweens to the first pose', () => {
		const now = [2000, 1400, 2700, 2048, 2100, 1800];
		const p = buildPath([kf('A', A), kf('B', B, { durationS: 1 })], { rateHz: 10, leadIn: { from: now } });
		expect(p.goal[0]).toEqual(now);
		expect(p.markers[0]).toMatchObject({ kind: 'lead-in', index: -1, t: 0 });
		expect(p.markers[1]).toMatchObject({ label: 'A', t: autoDurationS(now, A) });
		expect(p.goal[p.goal.length - 1]).toEqual(B);
	});

	it('no lead-in when the arm is already at the first pose', () => {
		const p = buildPath([kf('A', A), kf('B', B)], { rateHz: 10, leadIn: { from: A } });
		expect(p.markers[0]).toMatchObject({ kind: 'pose', label: 'A', t: 0 });
	});

	it('tooFast flags a transition the arm cannot make', () => {
		const far = [A[0] + 3000, ...A.slice(1)];
		// 3000 steps at easy ease: 3000 × 1.875 / 2000 = 2.81 → 2.9 s.
		expect(tooFast([kf('A', A), kf('far', far, { durationS: 0.5 })])).toEqual([{ index: 1, message: expect.stringContaining('at least 2.9 s') }]);
		expect(tooFast([kf('A', A), kf('far', far, { durationS: 2, easing: 'linear' })])).toEqual([]);
		expect(tooFast([kf('A', A), kf('far', far, { durationS: 3 })])).toEqual([]);
		const p = buildPath([kf('A', A), kf('far', far, { durationS: 0.5 })]);
		expect(pathStats(p).tooFast).toEqual([1]);
		expect(pathStats(p).maxStepsPerS[0]).toBeGreaterThan(MAX_STEPS_PER_S);
	});
});

describe('sequences', () => {
	it('joins move sets with an automatic transition into the next set', () => {
		const flat = flattenSequence([
			{ name: 'wave', keyframes: [kf('A', A), kf('B', B, { durationS: 1 })], join: { durationS: null, easing: 'ease' } },
			{ name: 'bow', keyframes: [kf('C', C), kf('A', A, { durationS: 2 })], join: { durationS: null, easing: 'ease' } }
		]);
		expect(flat.map((k) => k.name)).toEqual(['wave · A', 'wave · B', 'bow · C', 'bow · A']);
		expect(flat[2].durationS).toBe(autoDurationS(B, C));
		expect((flat[2] as any).kind).toBe('join');
		const p = buildPath(flat, { rateHz: 10 });
		expect(p.markers.map((m) => m.kind)).toEqual(['pose', 'pose', 'join', 'pose']);
	});
	it('a set that starts where the last ended just extends the hold', () => {
		const flat = flattenSequence([
			{ name: 'x', keyframes: [kf('A', A), kf('B', B, { holdS: 1 })], join: { durationS: null, easing: 'ease' } },
			{ name: 'y', keyframes: [kf('B', B, { holdS: 0.5 }), kf('C', C)], join: { durationS: null, easing: 'ease' } }
		]);
		expect(flat.length).toBe(3);
		expect(flat[1].holdS).toBe(1.5);
	});
});

describe('composeAnimationJsonl', () => {
	it('writes the Pi recording format with the first frame as neutral', () => {
		const p = buildPath([kf('A', A), kf('B', B, { durationS: 1 })], { rateHz: 10 });
		const out = composeAnimationJsonl(p, { jointNames: ['a', 'b', 'c', 'd', 'e', 'f'], title: 'test', now: new Date('2026-10-21T00:00:00Z') });
		const lines = out.jsonl.trim().split('\n').map((l) => JSON.parse(l));
		expect(lines[0]).toMatchObject({ event: 'header', rate_hz: 10, follower_neutral: A, animated: 'test' });
		expect(lines[1]).toEqual({ event: 'frame', t: 0, goal: A });
		expect(lines[lines.length - 2]).toEqual({ event: 'frame', t: 1, goal: B, settle: true, pose: 'B', target: B });
		expect(lines[lines.length - 1]).toEqual({ event: 'footer', duration_s: 1, frames: 11 });
		expect(out.frames).toBe(11);
	});
});

describe('settle flags for the closed-loop replay', () => {
	it('flags the arrival at every held pose and the last frame, never the lead-in', () => {
		const p = buildPath([kf('A', A, { holdS: 0.5 }), kf('B', B, { durationS: 1 }), kf('C', C, { durationS: 1, holdS: 1 })], { rateHz: 10, leadIn: { from: [2000, 1500, 2600, 2048, 2100, 1800], durationS: 1 } });
		const flags = settleFrames(p);
		// A is reached after the 1 s lead-in (frame 10), C after 1 + 0.5 + 1 + 1 = 3.5 s (frame 35); B is a stop that is not held.
		expect(flags.map((f) => [f.frame, f.pose])).toEqual([
			[10, 'A'],
			[35, 'C']
		]);
		expect(flags[1].target).toEqual(C);
	});
	it('the last frame is flagged even when it is not held', () => {
		const p = buildPath([kf('A', A), kf('B', B, { durationS: 1 })], { rateHz: 10 });
		expect(settleFrames(p)).toEqual([{ frame: 10, pose: 'B', target: B }]);
	});
	it('a trimmed keyframe flags its untrimmed target, so the Pi reports droop against the real pose', () => {
		const trimmed = kf('A', [2048, 1512, 2592, 2048, 2100, 1800], { target: A });
		const p = buildPath([trimmed], { rateHz: 10 });
		expect(settleFrames(p)[0].target).toEqual(A);
	});
	it('trimFromSettle: written − target on servos 1–5, capped, gripper ignored', () => {
		expect(trimFromSettle([2048, 1514, 2591, 2051, 2100, 1900], A)).toEqual([0, 14, -9, 3, 0, 0]);
		expect(trimFromSettle([2048, 1700, 2600, 2048, 2100, 1800], A)![1]).toBe(MAX_TRIM_STEPS);
		expect(trimFromSettle([1, 2], A)).toBeNull();
		expect(trimFromSettle(undefined, A)).toBeNull();
	});
});

describe('timeline offsets', () => {
	it('cleanOffsets keeps six whole steps within the limit and drops all-zero', () => {
		expect(cleanOffsets([1.4, -2.6, 0, 0, 0, 5000], 1000)).toEqual([1, -3, 0, 0, 0, 1000]);
		expect(cleanOffsets([0, 0, 0, 0, 0, 0], 1000)).toBeNull();
		expect(cleanOffsets([1, 2], 1000)).toBeNull();
		expect(cleanOffsets(undefined, 1000)).toBeNull();
	});
	it('cleanKeyframes keeps offsets only when something moved', () => {
		const [a, b] = cleanKeyframes([
			{ poseId: 'p', durationS: 1, offsets: [0, 12, 0, 0, 0, 0] },
			{ poseId: 'q', durationS: 1, offsets: [0, 0, 0, 0, 0, 0] }
		]);
		expect(a.offsets).toEqual([0, 12, 0, 0, 0, 0]);
		expect('offsets' in b).toBe(false);
	});
	it('keyframePositions adds offsets and trim, clamped to the encoder', () => {
		expect(keyframePositions([100, 2000, 4090, 0, 0, 0], [0, 30, 10, -5, 0, 0], [0, 12, 0, 0, 0, 0])).toEqual([100, 2042, 4095, 0, 0, 0]);
		expect(keyframePositions(A)).toEqual(A);
	});
	it('markers carry each pose position, so the timeline can draw its dots', () => {
		const p = buildPath([kf('A', A), kf('B', B)], { rateHz: 10 });
		expect(p.markers.map((m) => m.positions)).toEqual([A, B]);
	});
});

describe('droop trim', () => {
	const pose = [2000, 2400, 2400, 1200, 540, 2250];
	it('adds the shortfall to the trim on servos 1–5, never the gripper', () => {
		const settled = [2000, 2388, 2409, 1197, 540, 2200];
		const r = nextTrim(pose, settled, [0, 0, 0, 0, 0, 0]);
		expect(r.residual).toEqual([0, 12, -9, 3, 0, 0]);
		expect(r.trim).toEqual([0, 12, -9, 3, 0, 0]);
		expect(r.done).toBe(false);
	});
	it('converges: a second round that lands on the pose keeps the trim', () => {
		const r = nextTrim(pose, [2000, 2399, 2401, 1200, 541, 2210], [0, 12, -9, 3, 0, 0]);
		expect(r.done).toBe(true);
		expect(r.trim).toEqual([0, 12, -9, 3, 0, 0]);
	});
	it('is capped, so a blocked joint cannot run away', () => {
		const r = nextTrim(pose, [2000, 2300, 2400, 1200, 540, 2250], [0, 40, 0, 0, 0, 0]);
		expect(r.trim[1]).toBe(MAX_TRIM_STEPS);
	});
	it('a simulated sagging servo lands on the pose once trimmed', () => {
		// Proportional position loop under a constant load: settles `sag` short of its goal.
		const sag = [0, 14, -8, 5, 0, 0];
		const settle = (goal: number[]) => goal.map((g, s) => g - sag[s]);
		let trim = [0, 0, 0, 0, 0, 0];
		for (let round = 0; round < 4; round++) {
			const r = nextTrim(pose, settle(keyframePositions(pose, null, trim)), trim);
			trim = r.trim;
			if (r.done) break;
		}
		expect(settle(keyframePositions(pose, null, trim)).slice(0, 5)).toEqual(pose.slice(0, 5));
	});
});

describe('estimateTrim (unvisited poses borrow from learned ones)', () => {
	const learned = { positions: [2000, 2400, 2400, 1200, 540, 2250], trim: [0, 12, -8, 4, 0, 0] };
	const far = { positions: [2000, 900, 3000, 1000, 540, 2250], trim: [0, -6, 2, 0, 0, 0] };
	it('a pose at the same shape gets that trim, whatever the base and gripper', () => {
		expect(estimateTrim([1000, 2400, 2400, 1200, 100, 1000], [learned, far])).toEqual([0, 12, -8, 4, 0, 0]);
	});
	it('a nearby pose gets a trim close to its neighbour; a far one is not used', () => {
		const e = estimateTrim([2000, 2450, 2380, 1220, 540, 2250], [learned, far])!;
		expect(e).toEqual([0, 12, -8, 4, 0, 0]);
	});
	it('nothing within the radius → null (plays untrimmed until visited)', () => {
		expect(estimateTrim([2000, 1600, 1600, 2400, 540, 2250], [learned, far])).toBeNull();
		expect(estimateTrim(learned.positions, [])).toBeNull();
	});
	it('between two learned poses it blends, nearer weighs more', () => {
		const a = { positions: [0, 2000, 2000, 2000, 0, 0], trim: [0, 20, 0, 0, 0, 0] };
		const b = { positions: [0, 2200, 2000, 2000, 0, 0], trim: [0, 0, 0, 0, 0, 0] };
		const e = estimateTrim([0, 2050, 2000, 2000, 0, 0], [a, b])!;
		expect(e[1]).toBeGreaterThan(10);
		expect(e[1]).toBeLessThan(20);
	});
});

describe('jog', () => {
	it('splits a jog into same-sign pieces the Pi accepts, remainder last', () => {
		expect(jogChunks(10)).toEqual([10]);
		expect(jogChunks(300)).toEqual([300]);
		expect(jogChunks(650)).toEqual([300, 300, 50]);
		expect(jogChunks(-650)).toEqual([-300, -300, -50]);
		expect(jogChunks(0)).toEqual([]);
		expect(jogChunks(7.9)).toEqual([7]);
		expect(jogChunks(25, 10)).toEqual([10, 10, 5]);
	});
});
