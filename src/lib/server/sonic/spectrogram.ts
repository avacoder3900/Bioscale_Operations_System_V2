/**
 * Fine spectrogram for the SONIC workflow (step 6): a Fourier transform every
 * 50 ms, power-summed into 64 log-spaced bands from 50 Hz to 16 kHz. Fine enough
 * to put an abnormal click or squeal at a specific moment (the fingerprint's
 * 0.5 s × 1/3-octave grid is too coarse for that).
 *
 * Stored compactly (one byte per value, 0.5 dB steps from DB_MIN) in GridFS
 * bucket `sonic_spectrograms` — ≈ 0.4 MB for a 5-min run — and rendered to a PNG
 * on demand for the page.
 */
import sharp from 'sharp';
import { SR } from './constants';
import { fft, hann } from './fft';

export const SPECTRO_VERSION = 1;
export const SPECTRO_NFFT = 2048; // ≈ 43 ms window, 23 Hz bins
export const SPECTRO_HOP = Math.round(0.05 * SR); // 50 ms frames
export const SPECTRO_FRAME_S = SPECTRO_HOP / SR;
export const SPECTRO_BANDS = 64;
export const SPECTRO_F_LO = 50;
export const SPECTRO_F_HI = 16_000;
export const DB_MIN = -130;
export const DB_STEP = 0.5;

/** Geometric band edges, SPECTRO_BANDS + 1 values. */
export const SPECTRO_EDGES: readonly number[] = Array.from(
	{ length: SPECTRO_BANDS + 1 },
	(_, k) => SPECTRO_F_LO * (SPECTRO_F_HI / SPECTRO_F_LO) ** (k / SPECTRO_BANDS)
);

export interface Spectrogram {
	frames: number;
	bands: number;
	frameS: number;
	/** Time (s) of frame 0's centre; frame k is at t0 + k·frameS. */
	t0: number;
	/** dB values, frame-major: data[frame * bands + band]. */
	db: Float32Array;
}

/** STFT → per-frame, per-band level in dB (power in the band). */
export function computeSpectrogram(x: Float32Array): Spectrogram {
	const n = SPECTRO_NFFT;
	const win = hann(n);
	let wp = 0;
	for (let i = 0; i < n; i++) wp += win[i] * win[i];
	const df = SR / n;
	const frames = x.length >= n ? Math.floor((x.length - n) / SPECTRO_HOP) + 1 : 0;
	const out = new Float32Array(frames * SPECTRO_BANDS);
	const re = new Float64Array(n);
	const im = new Float64Array(n);
	// Which FFT bin range feeds each band (at least one bin per band).
	const binLo: number[] = [];
	const binHi: number[] = [];
	for (let b = 0; b < SPECTRO_BANDS; b++) {
		const lo = Math.max(1, Math.floor(SPECTRO_EDGES[b] / df));
		const hi = Math.max(lo, Math.min(n / 2, Math.ceil(SPECTRO_EDGES[b + 1] / df) - 1));
		binLo.push(lo);
		binHi.push(hi);
	}
	const scale = 2 / (SR * wp);
	for (let f = 0; f < frames; f++) {
		const off = f * SPECTRO_HOP;
		let mean = 0;
		for (let i = 0; i < n; i++) mean += x[off + i];
		mean /= n;
		for (let i = 0; i < n; i++) {
			re[i] = (x[off + i] - mean) * win[i];
			im[i] = 0;
		}
		fft(re, im);
		for (let b = 0; b < SPECTRO_BANDS; b++) {
			let p = 0;
			for (let k = binLo[b]; k <= binHi[b]; k++) p += (re[k] * re[k] + im[k] * im[k]) * scale;
			out[f * SPECTRO_BANDS + b] = 10 * Math.log10(p * df + 1e-20);
		}
	}
	return { frames, bands: SPECTRO_BANDS, frameS: SPECTRO_FRAME_S, t0: n / 2 / SR, db: out };
}

/** One byte per value: round((dB − DB_MIN) / DB_STEP), clamped to 0..255. */
export function encodeSpectrogram(s: Spectrogram): Uint8Array {
	const out = new Uint8Array(s.db.length);
	for (let i = 0; i < s.db.length; i++) {
		const v = Math.round((s.db[i] - DB_MIN) / DB_STEP);
		out[i] = v < 0 ? 0 : v > 255 ? 255 : v;
	}
	return out;
}

export function decodeSpectrogram(bytes: Uint8Array, meta: { frames: number; bands: number; frameS: number; t0: number }): Spectrogram {
	const db = new Float32Array(bytes.length);
	for (let i = 0; i < bytes.length; i++) db[i] = DB_MIN + bytes[i] * DB_STEP;
	return { ...meta, db };
}

/** dark → magenta → orange → yellow (same ramp as the fingerprint heatmap). */
function ramp(x: number): [number, number, number] {
	const r = Math.round(255 * Math.min(1, x * 1.6));
	const g = Math.round(Math.min(255, 255 * Math.max(0, x - 0.45) * 1.8));
	const b = Math.round(255 * Math.max(0, 0.6 - Math.abs(x - 0.35)) * 1.2);
	return [r, g, Math.min(255, b)];
}

/**
 * Render the spectrogram (or the [fromS, toS] part of it) as a PNG: time left →
 * right, low frequencies at the bottom. Columns are max-pooled down to `width`,
 * colour spans the loudest value down 60 dB.
 */
export async function renderSpectrogramPng(s: Spectrogram, opts: { width?: number; rowPx?: number; fromS?: number; toS?: number } = {}): Promise<Buffer> {
	const f0 = Math.max(0, Math.floor(((opts.fromS ?? 0) - s.t0) / s.frameS));
	const f1 = Math.min(s.frames, Math.ceil(((opts.toS ?? Infinity) - s.t0) / s.frameS) + 1);
	const nF = Math.max(1, f1 - f0);
	const width = Math.max(1, Math.min(opts.width ?? 1800, nF));
	const rowPx = opts.rowPx ?? 4;
	const height = s.bands * rowPx;
	// Colour range from the 99.5th percentile of the shown part.
	const sample: number[] = [];
	const stride = Math.max(1, Math.floor((nF * s.bands) / 50_000));
	for (let i = f0 * s.bands; i < f1 * s.bands; i += stride) sample.push(s.db[i]);
	sample.sort((a, b) => a - b);
	const hi = sample.length ? sample[Math.floor(sample.length * 0.995)] : 0;
	const lo = hi - 60;
	const px = Buffer.alloc(width * height * 3);
	for (let c = 0; c < width; c++) {
		const a = f0 + Math.floor((c * nF) / width);
		const z = Math.max(a + 1, f0 + Math.floor(((c + 1) * nF) / width));
		for (let b = 0; b < s.bands; b++) {
			let v = -Infinity;
			for (let f = a; f < z && f < f1; f++) v = Math.max(v, s.db[f * s.bands + b]);
			const [r, g, bl] = ramp(Number.isFinite(v) ? Math.min(1, Math.max(0, (v - lo) / (hi - lo))) : 0);
			for (let y = 0; y < rowPx; y++) {
				const row = height - 1 - (b * rowPx + y);
				const o = (row * width + c) * 3;
				px[o] = r;
				px[o + 1] = g;
				px[o + 2] = bl;
			}
		}
	}
	return sharp(px, { raw: { width, height, channels: 3 } }).png({ compressionLevel: 6 }).toBuffer();
}
