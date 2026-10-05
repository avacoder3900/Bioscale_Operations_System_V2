import { describe, expect, it } from 'vitest';
import { buildTimeline, expectedLoudness, type Timeline } from './timeline';
import { alignTimeline, analyzeWindow, mapPlanTime, suggestWindow } from './window';
import { computeSpectrogram, decodeSpectrogram, encodeSpectrogram, SPECTRO_BANDS, SPECTRO_FRAME_S, type Spectrogram } from './spectrogram';
import { SR } from './constants';

// A small SONIC-like plan: start, moves, waits, a 6× repeat and an oscillation.
const CODE = [
	{ command: 'Start Test', params: {} },
	{ command: 'Move Microns', params: { microns: -1750, step_delay_us: 20000 } }, // 2.8 s
	{ command: 'Delay', params: { delay_ms: 3000 } },
	{ command: 'Repeat', count: 6, params: {}, code: [
		{ command: 'Move Microns', params: { microns: 300, step_delay_us: 20000 } }, // 0.48 s
		{ command: 'Delay', params: { delay_ms: 1500 } }
	] },
	{ command: 'Delay', params: { delay_ms: 4000 } },
	{ command: 'Sinusoidal Oscillate', params: { microns: 3500, peak_delay_us: 350, shape_pct: 50, cycles: 60 } },
	{ command: 'Delay', params: { delay_ms: 3000 } },
	{ command: 'Move Microns', params: { microns: 2950, step_delay_us: 20000 } },
	{ command: 'Finish Test', params: {} }
];

/**
 * Synthetic spectrogram of the plan played starting at `offsetS`, each step kind at
 * its own speed (`speed(kind)` = recording s per plan s). Loudness follows the
 * plan's expected loudness. Returns the true recording start time of every step.
 */
function synth(tl: Timeline, offsetS: number, speed: (kind: string) => number, padS = 6) {
	const starts: number[] = [];
	let t = offsetS;
	for (const st of tl.steps) {
		starts.push(t);
		t += (st.t1 - st.t0) * speed(st.kind);
	}
	const end = t;
	const frames = Math.floor((end + padS) / SPECTRO_FRAME_S);
	const db = new Float32Array(frames * SPECTRO_BANDS);
	let seed = 7;
	const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.6;
	for (let f = 0; f < frames; f++) {
		const tr = f * SPECTRO_FRAME_S;
		let loud = 0;
		const k = starts.findIndex((s0, i) => tr >= s0 && tr < (starts[i + 1] ?? end));
		if (k >= 0) {
			const st = tl.steps[k];
			const n = st.t0 + (tr - starts[k]) / speed(st.kind); // plan time
			loud = expectedLoudness(tl, n);
		}
		for (let b = 0; b < SPECTRO_BANDS; b++) db[f * SPECTRO_BANDS + b] = -75 + 35 * loud - b * 0.3 + rnd();
	}
	const spec: Spectrogram = { frames, bands: SPECTRO_BANDS, frameS: SPECTRO_FRAME_S, t0: 0, db };
	return { spec, starts, end };
}
const uniform = (v: number) => () => v;

describe('SONIC timeline', () => {
	const tl = buildTimeline(CODE as any);
	it('times every step with the firmware model and keeps its 1-based order', () => {
		expect(tl.steps.map((s) => s.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
		expect(tl.steps[0].t1).toBeCloseTo(9, 3); // Start Test
		expect(tl.steps[1].t1 - tl.steps[1].t0).toBeCloseTo(2.8, 3);
		const rep = tl.steps[3];
		expect(rep.kind).toBe('repeat');
		expect(rep.parts).toHaveLength(6);
		expect(rep.t1 - rep.t0).toBeCloseTo(6 * (0.48 + 1.5), 2);
	});
	it('slices an oscillation into parts of at least ~1 s', () => {
		const osc = tl.steps[5];
		const dur = osc.t1 - osc.t0;
		expect(osc.parts.length).toBe(Math.min(60, Math.floor(dur)));
		for (const p of osc.parts) expect(p.t1 - p.t0).toBeGreaterThanOrEqual(0.999);
	});
});

describe('SONIC window analysis', () => {
	const tl = buildTimeline(CODE as any);
	it('maps every step of a uniformly slow unit to the right moment', () => {
		const { spec, starts, end } = synth(tl, 7.3, uniform(1.04));
		const al = alignTimeline(spec, tl, 6, end + 2);
		expect(al.quality).toBe('good');
		tl.steps.slice(1).forEach((st, i) => expect(Math.abs(mapPlanTime(al, st.t0) - starts[i + 1])).toBeLessThan(0.5));
	});
	it('follows step kinds running at different speeds (moves fast, oscillations slow)', () => {
		const speed = (k: string) => (k === 'oscillate' ? 1.2 : k === 'move' || k === 'repeat' ? 0.8 : 1);
		const { spec, starts, end } = synth(tl, 3, speed);
		const al = alignTimeline(spec, tl, 2, end + 1);
		expect(al.quality).toBe('good');
		tl.steps.slice(1).forEach((st, i) => expect(Math.abs(mapPlanTime(al, st.t0) - starts[i + 1])).toBeLessThan(0.5));
	});
	it('finds nothing on a clean run', () => {
		const { spec, end } = synth(tl, 2, uniform(1));
		const wa = analyzeWindow(spec, tl, 1, end + 2);
		expect(wa.anomalies.filter((a) => a.kind === 'repetition')).toHaveLength(0);
	});
	it('flags the one repetition that sounds different, at its moment and band', () => {
		const { spec, end } = synth(tl, 2, uniform(1));
		const rep = tl.steps[3];
		const p = rep.parts[3]; // 4th repetition: +18 dB in bands 40–43 during its move
		const fa = Math.round((2 + p.t0 + 0.1) / SPECTRO_FRAME_S);
		for (let f = fa; f < fa + 5; f++) for (let b = 40; b < 44; b++) spec.db[f * SPECTRO_BANDS + b] += 18;
		const wa = analyzeWindow(spec, tl, 1, end + 2);
		const hit = wa.anomalies.find((a) => a.kind === 'repetition');
		expect(hit).toBeTruthy();
		expect(hit!.step).toBe(4);
		expect(hit!.t).toBeGreaterThanOrEqual(2 + p.t0);
		expect(hit!.t).toBeLessThanOrEqual(2 + p.t1);
		expect(hit!.deltaDb).toBeGreaterThan(10);
	});
	it('flags a short broadband click', () => {
		const { spec, end } = synth(tl, 2, uniform(1));
		const f = Math.round(15.3 / SPECTRO_FRAME_S); // middle of the 3 s wait (step 3), away from motion edges
		for (let b = 5; b < 40; b++) spec.db[f * SPECTRO_BANDS + b] += 30;
		const wa = analyzeWindow(spec, tl, 1, end + 2);
		const click = wa.anomalies.find((a) => a.kind === 'click');
		expect(click).toBeTruthy();
		expect(Math.abs(click!.t - 15.3)).toBeLessThan(0.15);
	});
});

describe('SONIC spectrogram + defaults', () => {
	it('puts a 1 kHz tone in the band that contains 1 kHz and survives byte encoding', () => {
		const x = new Float32Array(SR * 2);
		for (let i = 0; i < x.length; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / SR);
		const s = computeSpectrogram(x);
		const mid = Math.floor(s.frames / 2);
		let best = 0;
		for (let b = 1; b < s.bands; b++) if (s.db[mid * s.bands + b] > s.db[mid * s.bands + best]) best = b;
		const lo = 50 * (16000 / 50) ** (best / 64);
		const hi = 50 * (16000 / 50) ** ((best + 1) / 64);
		expect(lo).toBeLessThanOrEqual(1000);
		expect(hi).toBeGreaterThanOrEqual(1000);
		const back = decodeSpectrogram(encodeSpectrogram(s), s);
		expect(Math.abs(back.db[mid * s.bands + best] - s.db[mid * s.bands + best])).toBeLessThanOrEqual(0.25);
	});
	it('suggests 1 s before the first motion and the plan + 1 s after it', () => {
		const w = suggestWindow([[12.4, 20, -30, -35, 400]], 400, 299.7, 9, 1, 1);
		expect(w.startS).toBeCloseTo(11.4, 2);
		expect(w.endS).toBeCloseTo(12.4 - 9 + 299.7 + 1, 2);
	});
});
