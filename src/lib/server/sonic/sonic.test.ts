import { describe, it, expect } from 'vitest';
import { SR, MAX_EXTREME_LABELS } from './constants';
import { welch } from './fft';
import { findPeaks, medfilt, percentile } from './stats';
import { fingerprint, type Fingerprint } from './features';
import { compareFingerprints, parseSections } from './compare';
import { decodeRecording, resampleTo48k, sniffFormat } from './decode';

/** Deterministic noise so tests never flake. */
function rng(seed: number) {
	return () => {
		seed |= 0;
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5;
	};
}

/** A fake 40 s "assay": quiet room + three motor phases (450 Hz with harmonics). */
function fakeRun(opts: { seed?: number; shiftS?: number; gainDb?: number; extraToneHz?: number; hissInPhases?: boolean } = {}) {
	const dur = 40;
	const shift = Math.round((opts.shiftS ?? 0) * SR);
	const n = dur * SR + shift;
	const x = new Float32Array(n);
	const r = rng(opts.seed ?? 1);
	const phases: [number, number][] = [[5, 12], [18, 25], [30, 34]];
	const g = 10 ** ((opts.gainDb ?? 0) / 20);
	for (let i = 0; i < n; i++) {
		const t = (i - shift) / SR;
		let v = 0.003 * r(); // room noise
		if (t >= 0 && phases.some(([a, b]) => t >= a && t < b)) {
			v += 0.05 * Math.sin(2 * Math.PI * 450 * t) + 0.02 * Math.sin(2 * Math.PI * 900 * t) + 0.01 * Math.sin(2 * Math.PI * 1350 * t);
			if (opts.hissInPhases) v += 0.04 * r();
		}
		if (opts.extraToneHz && t >= 0) v += 0.01 * Math.sin(2 * Math.PI * opts.extraToneHz * t);
		x[i] = v * g;
	}
	return x;
}

const fpCache = new Map<string, Fingerprint>();
function fpOf(key: string, make: () => Float32Array): Fingerprint {
	if (!fpCache.has(key)) fpCache.set(key, fingerprint(make()));
	return fpCache.get(key)!;
}

describe('dsp helpers', () => {
	it('welch puts a 1 kHz sine at 1 kHz ± one bin', () => {
		const x = Float32Array.from({ length: SR * 2 }, (_, i) => Math.sin((2 * Math.PI * 1000 * i) / SR));
		const { df, psd } = welch(x, SR, 8192);
		let best = 0;
		for (let k = 1; k < psd.length; k++) if (psd[k] > psd[best]) best = k;
		expect(Math.abs(best * df - 1000)).toBeLessThanOrEqual(df);
	});

	it('medfilt zero-pads like scipy', () => {
		expect(Array.from(medfilt([5, 5, 5], 3))).toEqual([5, 5, 5]);
		expect(Array.from(medfilt([-40, -40, -40], 3))).toEqual([-40, -40, -40]);
		expect(Array.from(medfilt([-40, -40, -40, -40, -40], 5))[0]).toBe(-40);
		expect(Array.from(medfilt([-40, -40, -40, -40, -40], 5))[0]).not.toBe(0);
	});

	it('percentile is numpy-linear', () => {
		expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
		expect(percentile([1, 2, 3, 4, 5], 20)).toBeCloseTo(1.8);
	});

	it('findPeaks reports plateau middles and prominence', () => {
		const p = findPeaks([0, 1, 3, 3, 3, 1, 0, 2, 0], { prominence: 1 });
		expect(p.map((q) => q.index)).toEqual([3, 7]);
		expect(p[0].prominence).toBe(3);
		expect(p[1].prominence).toBe(2);
	});

	it('sniffs m4a / wav from bytes', () => {
		const wav = new TextEncoder().encode('RIFF\0\0\0\0WAVEfmt ');
		const m4a = new Uint8Array([0, 0, 0, 0x20, ...new TextEncoder().encode('ftypM4A ')]);
		expect(sniffFormat(wav)).toBe('wav');
		expect(sniffFormat(m4a)).toBe('aac');
		expect(sniffFormat(new Uint8Array([1, 2, 3, 4]), 'x.ogg')).toBeNull();
	});

	it('resamples 44.1 kHz to 48 kHz keeping the tone', () => {
		const x = Float32Array.from({ length: 44100 }, (_, i) => Math.sin((2 * Math.PI * 440 * i) / 44100));
		const y = resampleTo48k(x, 44100);
		expect(y.length).toBe(48000);
		const { df, psd } = welch(y, SR, 8192);
		let best = 0;
		for (let k = 1; k < psd.length; k++) if (psd[k] > psd[best]) best = k;
		expect(Math.abs(best * df - 440)).toBeLessThanOrEqual(df);
	});
});

describe('fingerprint', () => {
	it('finds the three phases and the 450 Hz motor tone', () => {
		const fp = fpOf('base', () => fakeRun());
		expect(fp.events.length).toBe(3);
		expect(Math.abs(fp.events[0][0] - 5)).toBeLessThan(0.6);
		const running = fp.domHz.filter((_, b) => b * 0.5 >= 6 && b * 0.5 < 11);
		expect(running.every((h) => h != null && Math.abs(h - 450) < 12)).toBe(true);
		expect(fp.bands[0].length).toBe(21);
	});
});

describe('compare', () => {
	it('identical copies: zero offset, every section passes', () => {
		const a = fpOf('base', () => fakeRun());
		const c = compareFingerprints([
			{ id: 'a', label: 'A', fp: a },
			{ id: 'b', label: 'B', fp: a },
			{ id: 'c', label: 'C', fp: a }
		]);
		expect(c.offsets).toEqual([0, 0, 0]);
		expect(c.sections.length).toBeGreaterThanOrEqual(3);
		for (const row of c.scores) expect(row.every((s) => s?.pass)).toBe(true);
	});

	it('recovers a 3 s start offset', () => {
		const c = compareFingerprints([
			{ id: 'a', label: 'A', fp: fpOf('base', () => fakeRun()) },
			{ id: 'b', label: 'B', fp: fpOf('shift', () => fakeRun({ shiftS: 3, gainDb: 6 })) }
		]);
		expect(Math.abs(c.offsets[1] - 3)).toBeLessThanOrEqual(0.05);
		expect(c.sim[1].avgAbsLvl!).toBeGreaterThan(5);
		expect(c.sim[1].avgShape!).toBeLessThan(1); // louder, not different
	});

	it('flags an injected 3 kHz tone', () => {
		const c = compareFingerprints([
			{ id: 'a', label: 'A', fp: fpOf('base', () => fakeRun()) },
			{ id: 'b', label: 'B', fp: fpOf('tone', () => fakeRun({ extraToneHz: 3000 })) }
		]);
		expect(c.tones[1].some(([hz]) => Math.abs(hz - 3000) < 30)).toBe(true);
	});

	it('leave-one-out flags only the odd unit', () => {
		const base = fpOf('base', () => fakeRun());
		const c = compareFingerprints([
			{ id: 'a', label: 'A', fp: base },
			{ id: 'b', label: 'B', fp: fpOf('b2', () => fakeRun({ seed: 2 })) },
			{ id: 'c', label: 'C', fp: fpOf('b3', () => fakeRun({ seed: 3 })) },
			{ id: 'd', label: 'D', fp: fpOf('hiss', () => fakeRun({ seed: 4, hissInPhases: true })) }
		]);
		const failed = c.scores.map((row) => row.filter((s) => s && !s.pass).length);
		expect(failed[3]).toBeGreaterThan(0);
		expect(failed.slice(0, 3)).toEqual([0, 0, 0]);
	});

	it('scores against a reference set and needs ≥ 3 references', () => {
		const items = [
			{ id: 'r1', label: 'R1', fp: fpOf('base', () => fakeRun()) },
			{ id: 'r2', label: 'R2', fp: fpOf('b2', () => fakeRun({ seed: 2 })) },
			{ id: 'r3', label: 'R3', fp: fpOf('b3', () => fakeRun({ seed: 3 })) },
			{ id: 'x', label: 'X', fp: fpOf('hiss', () => fakeRun({ seed: 4, hissInPhases: true })) }
		];
		const ok = compareFingerprints(items, { referenceIds: ['r1', 'r2', 'r3'] });
		expect(ok.scoredAgainst).toBe('references');
		expect(ok.scores[3].some((s) => s && !s.pass)).toBe(true);
		const few = compareFingerprints(items, { referenceIds: ['r1', 'r2'] });
		expect(few.scores[3].every((s) => s === null)).toBe(true);
	});

	it('parses custom sections and rejects nonsense', () => {
		expect(parseSections('5-12, 18 – 25', [0, 40])).toEqual([
			{ name: 'S1', a: 5, b: 12 },
			{ name: 'S2', a: 18, b: 25 }
		]);
		expect(() => parseSections('abc', [0, 40])).toThrow(/start-end/);
		expect(() => parseSections('100-120', [0, 40])).toThrow(/outside/);
	});
});

/** Every number reachable in `o` (fingerprints/compare results are stored as JSON). */
function nonFinite(o: unknown, path = ''): string[] {
	if (typeof o === 'number') return Number.isFinite(o) ? [] : [`${path}=${o}`];
	if (Array.isArray(o)) return o.flatMap((v, i) => nonFinite(v, `${path}[${i}]`));
	if (o && typeof o === 'object') return Object.entries(o).flatMap(([k, v]) => nonFinite(v, `${path}.${k}`));
	return [];
}

/** Hand-built fingerprint: 0.5 s bins, 21 flat bands at the bin level, random 50 ms envelope. */
function synthFp(opts: { levelDb: number[]; domHz?: (number | null)[]; envPad?: number; seed?: number }): Fingerprint {
	const r = rng(opts.seed ?? 7);
	const nb = opts.levelDb.length;
	const env = Array.from({ length: nb * 10 }, () => Math.round((-30 + 20 * r()) * 10) / 10);
	const pad = opts.envPad ?? 0;
	return {
		durationS: nb * 0.5 + pad * 0.05,
		sampleRate: SR,
		envDb: [...Array.from({ length: pad }, () => -30), ...env],
		binS: 0.5,
		levelDb: opts.levelDb,
		domHz: opts.domHz ?? opts.levelDb.map(() => 450),
		bands: opts.levelDb.map((v) => Array.from({ length: 21 }, () => v)),
		psdDb: Array.from({ length: 100 }, () => -80),
		psdHzStep: SR / 8192,
		summary: { rmsDb: -30, peakDbfs: -10, noiseFloorDb: -40, centroidHz: 500, rolloffHz: 900, flatness: 0, bandLevels: [0, 0, 0, 0, 0], tones: [] },
		events: []
	};
}

/** Minimal IEEE-float mono WAV. */
function floatWav(samples: Float32Array, rate: number): Uint8Array {
	const buf = new ArrayBuffer(44 + samples.length * 4);
	const v = new DataView(buf);
	const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
	str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 4, true); str(8, 'WAVE');
	str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 3, true); v.setUint16(22, 1, true);
	v.setUint32(24, rate, true); v.setUint32(28, rate * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 32, true);
	str(36, 'data'); v.setUint32(40, samples.length * 4, true);
	samples.forEach((s, i) => v.setFloat32(44 + i * 4, s, true));
	return new Uint8Array(buf);
}

describe('regressions (engine review)', () => {
	it('re-binning a shifted recording mixes neighbouring bins in power, not in dB', () => {
		// B is A starting 0.25 s later → every shared-grid bin straddles two stored bins half/half.
		const level = Array.from({ length: 40 }, (_, b) => (b % 2 ? -40 : -20));
		const a = synthFp({ levelDb: level });
		const b = synthFp({ levelDb: level, envPad: 5 });
		const c = compareFingerprints([
			{ id: 'a', label: 'A', fp: a },
			{ id: 'b', label: 'B', fp: b }
		]);
		expect(c.offsets[1]).toBeCloseTo(0.25, 5);
		const mid = c.series[1].level.slice(2, -2);
		const want = 10 * Math.log10((0.01 + 0.0001) / 2); // −22.97 dB; dB-linear would say −30
		for (const v of mid) expect(v).toBeCloseTo(want, 1);
	});

	it('silent input gives a JSON-safe fingerprint and comparison', () => {
		const fp = fingerprint(new Float32Array(SR * 3));
		expect(nonFinite(fp)).toEqual([]);
		expect(fp.summary.centroidHz).toBe(0);
		expect(fp.summary.flatness).toBe(0);
		const c = compareFingerprints(['a', 'b', 'c'].map((id) => ({ id, label: id, fp })));
		expect(nonFinite(c)).toEqual([]);
	});

	it('rejects input shorter than one analysis segment instead of storing NaN', () => {
		expect(() => fingerprint(new Float32Array(4800))).toThrow(/too short/);
		expect(() => fingerprint(new Float32Array(0))).toThrow(/too short/);
		expect(() => welch(new Float32Array(1), SR, 8192)).toThrow(/at least 2/);
	});

	it('peak/min loudness stay finite when the window is narrower than a stored bin', () => {
		const fp = synthFp({ levelDb: [-30] });
		fp.durationS = 0.2;
		fp.envDb = fp.envDb.slice(0, 4);
		const c = compareFingerprints(['a', 'b', 'c'].map((id) => ({ id, label: id, fp })));
		expect(nonFinite(c.sim)).toEqual([]);
		expect(c.sim[0].peakDb).toBe(-30);
	});

	it('caps frequency extremes per SPU like the prototype, keeping the most extreme', () => {
		// 20 running stretches of 4 bins, each with its own peak/valley, separated by a quiet bin.
		const level: number[] = [];
		const dom: number[] = [];
		for (let s = 0; s < 20; s++) {
			for (let q = 0; q < 4; q++) {
				level.push(-20);
				dom.push(450 + (q === 1 ? 10 + s * 5 : q === 2 ? -30 : 0));
			}
			level.push(-60);
			dom.push(450);
		}
		const fp = synthFp({ levelDb: level, domHz: dom });
		const c = compareFingerprints([
			{ id: 'a', label: 'A', fp },
			{ id: 'b', label: 'B', fp }
		]);
		const ex = c.extremes[0];
		expect(ex.length).toBe(MAX_EXTREME_LABELS);
		expect(ex.map((e) => e[0])).toEqual([...ex.map((e) => e[0])].sort((x, y) => x - y));
		expect(Math.max(...ex.filter((e) => e[2] === 'peak').map((e) => e[1]))).toBe(450 + 10 + 19 * 5);
	});

	it('polyphase resampler matches the direct kernel and gives exact integer lengths', () => {
		const x = Float32Array.from({ length: 44100 }, (_, i) => Math.sin((2 * Math.PI * 440 * i) / 44100) + 0.2 * Math.sin((2 * Math.PI * 5000 * i) / 44100));
		const fast = resampleTo48k(x, 44100); // table path
		const direct = resampleTo48k(x, 44100 + 1e-9); // non-integer rate → per-sample kernel
		expect(fast.length).toBe(48000);
		let m = 0;
		for (let i = 0; i < direct.length; i++) m = Math.max(m, Math.abs(fast[i] - direct[i]));
		expect(direct.length).toBeGreaterThan(47990);
		expect(m).toBeLessThan(1e-4);
		expect(resampleTo48k(new Float32Array(16000), 16000).length).toBe(48000);
		expect(() => resampleTo48k(x, 0)).toThrow(/sample rate/);
	});

	it('decode zeroes non-finite samples so a bad frame cannot poison the fingerprint', async () => {
		const x = Float32Array.from({ length: SR * 2 }, (_, i) => 0.1 * Math.sin((2 * Math.PI * 440 * i) / SR));
		x[1000] = NaN;
		x[2000] = Infinity;
		const { samples, decoder } = await decodeRecording(floatWav(x, SR), 'nan.wav');
		expect(decoder).toBe('wav');
		expect(samples.every((v) => Number.isFinite(v))).toBe(true);
		expect(nonFinite(fingerprint(samples))).toEqual([]);
	});
});
