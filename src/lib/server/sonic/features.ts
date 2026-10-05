/**
 * Sonic fingerprint (VALIDATION-08): everything later comparisons need,
 * computed once from the decoded recording and stored on the session so the
 * compare page never has to touch audio again. Port of analyze_samples() +
 * time_series() in the prototype spu_audio.py.
 */
import {
	SR, FRAME_S, BIN_S, WELCH_NPERSEG, SPEC_NPERSEG, SPEC_HOP, MIN_FREQ, PSD_MAX_HZ,
	FREQ_LO, FREQ_HI, BANDS5, THIRD_OCT, EVENT_RISE_DB, EVENT_SMOOTH_S, EVENT_GAP_S, EVENT_MIN_S
} from './constants';
import { addSegmentPsd, tukey, welch, windowPower } from './fft';
import { db, findPeaks, medfilt, percentile, r1 } from './stats';

export interface SonicEvent {
	start: number;
	end: number;
	peakDb: number;
	meanDb: number;
	domHz: number | null;
}

export interface Fingerprint {
	durationS: number;
	sampleRate: number;
	envDb: number[]; // FRAME_S loudness envelope, dBFS
	binS: number;
	levelDb: number[]; // per BIN_S bin, dBFS
	domHz: (number | null)[]; // dominant FREQ_LO..FREQ_HI, median-filtered (not masked)
	bands: number[][]; // [bin][21] 1/3-octave levels, dB
	psdDb: number[]; // Welch spectrum 0..PSD_MAX_HZ, dB/Hz
	psdHzStep: number;
	summary: {
		rmsDb: number;
		peakDbfs: number;
		noiseFloorDb: number;
		centroidHz: number;
		rolloffHz: number;
		flatness: number;
		bandLevels: number[];
		tones: [number, number][]; // [Hz, dB]
	};
	events: [number, number, number, number, number | null][]; // start, end, peakDb, meanDb, domHz
}

/** Loudness envelope in dBFS (mean-square per FRAME_S frame). */
export function envelopeDb(x: Float32Array): Float64Array {
	const f = Math.round(FRAME_S * SR);
	const n = Math.floor(x.length / f);
	const out = new Float64Array(n);
	for (let i = 0; i < n; i++) {
		let s = 0;
		for (let j = i * f; j < (i + 1) * f; j++) s += x[j] * x[j];
		out[i] = db(s / f);
	}
	return out;
}

export function smoothEnv(env: ArrayLike<number>): Float64Array {
	return medfilt(env, Math.floor(EVENT_SMOOTH_S / FRAME_S) | 1);
}

function dominantFreq(seg: Float32Array): number | null {
	if (seg.length < 256) return null;
	const { df, psd } = welch(seg, SR, Math.min(4096, seg.length));
	let best = -1;
	let bestP = -Infinity;
	for (let k = 0; k < psd.length; k++) {
		if (k * df >= MIN_FREQ && psd[k] > bestP) {
			bestP = psd[k];
			best = k;
		}
	}
	return best < 0 ? null : best * df;
}

export function detectEvents(x: Float32Array, env: Float64Array, noiseFloor: number): SonicEvent[] {
	const sm = smoothEnv(env);
	const spans: [number, number][] = [];
	let start = -1;
	for (let i = 0; i < sm.length; i++) {
		const on = sm[i] > noiseFloor + EVENT_RISE_DB;
		if (on && start < 0) start = i;
		else if (!on && start >= 0) {
			spans.push([start, i]);
			start = -1;
		}
	}
	if (start >= 0) spans.push([start, sm.length]);
	const gap = Math.floor(EVENT_GAP_S / FRAME_S);
	const merged: [number, number][] = [];
	for (const s of spans) {
		const last = merged[merged.length - 1];
		if (last && s[0] - last[1] <= gap) last[1] = s[1];
		else merged.push([s[0], s[1]]);
	}
	const f = Math.round(FRAME_S * SR);
	const out: SonicEvent[] = [];
	for (const [s, e] of merged) {
		if ((e - s) * FRAME_S < EVENT_MIN_S) continue;
		let peak = -Infinity;
		let pow = 0;
		for (let i = s; i < e; i++) {
			peak = Math.max(peak, env[i]);
			pow += 10 ** (env[i] / 10);
		}
		out.push({
			start: s * FRAME_S,
			end: e * FRAME_S,
			peakDb: peak,
			meanDb: db(pow / (e - s)),
			domHz: dominantFreq(x.subarray(s * f, e * f))
		});
	}
	return out;
}

/** Power-summed levels (dB) of `psd` (spacing df) between each [lo, hi). */
function bandSums(psd: ArrayLike<number>, df: number, edges: ReadonlyArray<readonly [number, number]>): number[] {
	return edges.map(([lo, hi]) => {
		let s = 0;
		const k0 = Math.ceil(lo / df);
		for (let k = k0; k < psd.length && k * df < hi; k++) s += psd[k];
		return db(s * df);
	});
}

/** Per-BIN_S aggregation of a Tukey spectrogram (scipy.signal.spectrogram defaults). */
function binSeries(x: Float32Array) {
	const n = SPEC_NPERSEG;
	const win = tukey(n, 0.25);
	const wp = windowPower(win);
	const scratch = { re: new Float64Array(n), im: new Float64Array(n) };
	const nb = Math.max(Math.floor(x.length / SR / BIN_S), 1);
	const nf = n / 2 + 1;
	const P = new Float64Array(nb * nf);
	const counts = new Uint32Array(nb);
	const frame = new Float64Array(nf);
	for (let off = 0; off + n <= x.length; off += SPEC_HOP) {
		frame.fill(0);
		addSegmentPsd(x, off, win, SR, frame, scratch, wp);
		const t = (off + n / 2) / SR;
		const b = Math.min(Math.floor(t / BIN_S), nb - 1);
		const base = b * nf;
		for (let k = 0; k < nf; k++) P[base + k] += frame[k];
		counts[b]++;
	}
	const df = SR / n;
	const kLo = Math.ceil(FREQ_LO / df);
	const kHi = Math.floor(FREQ_HI / df);
	const thirdEdges = THIRD_OCT.slice(0, -1).map((lo, i) => [lo, THIRD_OCT[i + 1]] as const);
	const levelDb: number[] = [];
	const dom: number[] = [];
	const bands: number[][] = [];
	for (let b = 0; b < nb; b++) {
		const c = Math.max(counts[b], 1);
		const row = P.subarray(b * nf, (b + 1) * nf);
		for (let k = 0; k < nf; k++) row[k] /= c;
		let total = 0;
		for (let k = 0; k < nf; k++) total += row[k];
		levelDb.push(r1(db(total * df)));
		let best = kLo;
		for (let k = kLo; k <= kHi; k++) if (row[k] > row[best]) best = k;
		dom.push(best * df);
		bands.push(bandSums(row, df, thirdEdges).map(r1));
	}
	// Python medfilt(dom, 3) runs before masking; masking (quiet bins) happens at compare time.
	const domF = medfilt(dom, 3);
	return { levelDb, domHz: Array.from(domF, (v) => Math.round(v)), bands };
}

export function fingerprint(x: Float32Array): Fingerprint {
	// Shorter than one full Welch/spectrogram segment: the PSD would use a
	// different bin width (psdHzStep) than every other fingerprint and no
	// spectrogram frame would exist. decode.ts already rejects < 1 s.
	if (x.length < Math.max(WELCH_NPERSEG, SPEC_NPERSEG)) throw new Error('recording is too short to analyze');
	const env = envelopeDb(x);
	const { df, psd } = welch(x, SR, WELCH_NPERSEG);
	let sumK = 0;
	let sumFK = 0;
	let logSum = 0;
	let nK = 0;
	const cum: number[] = [];
	for (let k = 0; k < psd.length; k++) {
		if (k * df < MIN_FREQ) continue;
		sumK += psd[k];
		sumFK += k * df * psd[k];
		logSum += Math.log(psd[k] + 1e-20);
		nK++;
		cum.push(sumK);
	}
	const kStart = Math.ceil(MIN_FREQ / df);
	const rollIdx = cum.findIndex((c) => c >= 0.85 * sumK);
	let ss = 0;
	let peak = 0;
	for (let i = 0; i < x.length; i++) {
		ss += x[i] * x[i];
		const a = Math.abs(x[i]);
		if (a > peak) peak = a;
	}
	const noiseFloor = percentile(smoothEnv(env), 20);

	// Tonal peaks: prominence ≥ 6 dB above 50 Hz, top 5 by height.
	const keptDb: number[] = [];
	for (let k = kStart; k < psd.length; k++) keptDb.push(db(psd[k]));
	const tones = findPeaks(keptDb, { prominence: 6 })
		.sort((a, b) => keptDb[b.index] - keptDb[a.index])
		.slice(0, 5)
		.map((p) => [Math.round((kStart + p.index) * df), r1(keptDb[p.index])] as [number, number]);

	const events = detectEvents(x, env, noiseFloor);
	const series = binSeries(x);
	const kMax = Math.min(psd.length, Math.floor(PSD_MAX_HZ / df) + 1);

	return {
		durationS: Math.round((x.length / SR) * 1000) / 1000,
		sampleRate: SR,
		envDb: Array.from(env, r1),
		binS: BIN_S,
		...series,
		psdDb: Array.from(psd.subarray(0, kMax), (p) => r1(db(p))),
		psdHzStep: df,
		summary: {
			rmsDb: r1(db(ss / x.length)),
			peakDbfs: r1(20 * Math.log10(Math.max(peak, 1e-12))),
			noiseFloorDb: r1(noiseFloor),
			// All-zero (silent) input has no spectrum above MIN_FREQ: 0/0 and x/0 here
			// would store NaN / Infinity, which is not JSON-safe. Report 0 instead.
			centroidHz: sumK > 0 ? Math.round(sumFK / sumK) : 0,
			rolloffHz: Math.round((kStart + Math.max(rollIdx, 0)) * df),
			flatness: sumK > 0 ? Math.round((Math.exp(logSum / nK) / (sumK / nK)) * 1000) / 1000 : 0,
			bandLevels: bandSums(psd, df, BANDS5.map(([lo, hi]) => [lo, hi] as const)).map(r1),
			tones
		},
		events: events.map((e) => [r1(e.start), r1(e.end), r1(e.peakDb), r1(e.meanDb), e.domHz == null ? null : Math.round(e.domHz)])
	};
}
