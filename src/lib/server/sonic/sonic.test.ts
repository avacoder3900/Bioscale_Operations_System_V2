import { describe, it, expect } from 'vitest';
import { SR } from './constants';
import { welch } from './fft';
import { findPeaks, medfilt, percentile } from './stats';
import { fingerprint, type Fingerprint } from './features';
import { compareFingerprints, parseSections } from './compare';
import { resampleTo48k, sniffFormat } from './decode';

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
