import { describe, expect, it } from 'vitest';
import { placeSteps, planToRecording, type PlanStep } from '$lib/sonic-placement';
import { buildTimeline, expectedLoudness, planSteps } from './timeline';
import { estimateLandmarks, mergeLandmarks } from './landmarks';
import { SPECTRO_BANDS, SPECTRO_FRAME_S, type Spectrogram } from './spectrogram';

const CODE = [
	{ command: 'Start Test', params: {} },
	{ command: 'Move Microns', params: { microns: -1750, step_delay_us: 20000 } }, // landmark
	{ command: 'Delay', params: { delay_ms: 3000 } },
	{ command: 'Repeat', count: 6, params: {}, code: [
		{ command: 'Move Microns', params: { microns: 300, step_delay_us: 20000 } },
		{ command: 'Delay', params: { delay_ms: 1500 } }
	] },
	{ command: 'Delay', params: { delay_ms: 4000 } },
	{ command: 'Sinusoidal Oscillate', params: { comment: 'oscillate in w1', microns: 3500, peak_delay_us: 350, shape_pct: 50, cycles: 60 } }, // landmark
	{ command: 'Move Microns', params: { microns: -2000, step_delay_us: 20000 } }, // landmark, straight after the oscillation
	{ command: 'Delay', params: { delay_ms: 3000 } },
	{ command: 'Move Microns', params: { microns: 2950, step_delay_us: 20000 } }, // landmark
	{ command: 'Finish Test', params: {} }
];

describe('step placement from landmarks', () => {
	const tl = buildTimeline(CODE as any);
	const plan = planSteps(tl);
	it('flags the loud steps as landmarks', () => {
		expect(plan.filter((p) => p.landmark).map((p) => p.index)).toEqual([2, 6, 7, 9]);
		expect(plan[5].short).toBe('Osc W1');
	});
	it('pins landmarks, shares each gap in proportion, and keeps steps in order', () => {
		const lms = [
			{ step: 2, t0: 10, t1: 11.5, source: 'user' as const },
			{ step: 6, t0: 40, t1: 55, source: 'estimate' as const },
			{ step: 7, t0: 55, t1: 56.5, source: 'estimate' as const },
			{ step: 9, t0: 60, t1: 62, source: 'estimate' as const }
		];
		const placed = placeSteps(plan, null, lms, 200);
		expect(placed[1].t0).toBe(10);
		expect(placed[5].t0).toBe(40);
		expect(placed[8].t1).toBe(62);
		for (let i = 1; i < placed.length; i++) expect(placed[i].t0).toBeGreaterThanOrEqual(placed[i - 1].t1 - 1e-6);
		// Steps 3..5 fill exactly the gap 11.5 → 40.
		expect(placed[2].t0).toBeCloseTo(11.5, 2);
		expect(placed[4].t1).toBeCloseTo(40, 2);
		// Plan time maps through the placement.
		expect(planToRecording(plan as PlanStep[], placed, plan[5].t0)).toBeCloseTo(40, 2);
	});
	it('marks steps past the end of a cut-short recording instead of squeezing them', () => {
		const placed = placeSteps(plan, null, [{ step: 6, t0: 40, t1: 55, source: 'estimate' }], 56);
		expect(placed[5].inRecording).toBe(true);
		expect(placed[9].inRecording).toBe(false);
	});
	it('lets a saved adjustment win over the estimate for that landmark only', () => {
		const est = [
			{ step: 2, t0: 1, t1: 2, source: 'estimate' as const, found: true },
			{ step: 6, t0: 5, t1: 9, source: 'estimate' as const, found: true }
		];
		const merged = mergeLandmarks(est, [{ step: 6, t0: 6, t1: 10, source: 'user' }]);
		expect(merged.find((l) => l.step === 2)!.source).toBe('estimate');
		expect(merged.find((l) => l.step === 6)).toMatchObject({ t0: 6, t1: 10, source: 'user' });
	});
});

describe('landmark estimates (sequence matching)', () => {
	const tl = buildTimeline(CODE as any);
	it('finds each landmark when moves run fast and oscillations slow, splitting a shared stretch', () => {
		// Real speeds like the fleet's: moves ×0.5, oscillations ×1.2, waits ×1.
		const speed = (k: string) => (k === 'oscillate' ? 1.2 : k === 'move' ? 0.5 : k === 'repeat' ? 0.9 : 1);
		const starts: number[] = [];
		let t = 4;
		for (const st of tl.steps) {
			starts.push(t);
			t += (st.t1 - st.t0) * speed(st.kind);
		}
		const end = t;
		const frames = Math.floor((end + 5) / SPECTRO_FRAME_S);
		const db = new Float32Array(frames * SPECTRO_BANDS);
		for (let f = 0; f < frames; f++) {
			const tr = f * SPECTRO_FRAME_S;
			const k = starts.findIndex((s0, i) => tr >= s0 && tr < (starts[i + 1] ?? end));
			let loud = 0;
			if (k >= 0) loud = expectedLoudness(tl, tl.steps[k].t0 + (tr - starts[k]) / speed(tl.steps[k].kind));
			for (let b = 0; b < SPECTRO_BANDS; b++) db[f * SPECTRO_BANDS + b] = -75 + 35 * loud - b * 0.3;
		}
		const spec: Spectrogram = { frames, bands: SPECTRO_BANDS, frameS: SPECTRO_FRAME_S, t0: 0, db };
		const { landmarks } = estimateLandmarks(spec, tl, 2, end + 2, null);
		expect(landmarks.map((l) => l.step)).toEqual([2, 6, 7, 9]);
		for (const l of landmarks) {
			expect(l.found).toBe(true);
			const i = l.step - 1;
			expect(Math.abs(l.t0 - starts[i])).toBeLessThan(0.4);
			expect(Math.abs(l.t1 - (starts[i + 1] ?? end))).toBeLessThan(0.6);
		}
	});
});
