/**
 * Decode a stored sonic recording to mono Float32 at 48 kHz, on the server,
 * with WASM/JS decoders only (no ffmpeg binary to bundle on Vercel):
 *   M4A / AAC / ALAC → @audio/decode-aac (FAAD2 WASM)
 *   WAV              → @audio/decode-wav
 * Other formats are stored but not analyzable yet (VALIDATION-08 §7.1).
 */
import { SR } from './constants';

export type DecoderKind = 'aac' | 'wav';

export class NotAnalyzableError extends Error {}

export function sniffFormat(bytes: Uint8Array, fileName = ''): DecoderKind | null {
	const ascii = (o: number, n: number) => String.fromCharCode(...bytes.subarray(o, o + n));
	if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return 'wav';
	if (bytes.length >= 8 && ascii(4, 4) === 'ftyp') return 'aac';
	if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0) return 'aac'; // ADTS
	const ext = (fileName.split('.').pop() ?? '').toLowerCase();
	if (ext === 'wav') return 'wav';
	if (['m4a', 'aac', 'mp4'].includes(ext)) return 'aac';
	return null;
}

const RS_HALF = 16; // kernel half-width, in input samples

/** Windowed-sinc weights for an output sample whose input-time centre is `frac` past tap floor(centre). */
function rsKernel(frac: number, cutoff: number): Float64Array {
	const k = new Float64Array(2 * RS_HALF);
	for (let m = 0; m < 2 * RS_HALF; m++) {
		const d = frac + RS_HALF - 1 - m; // centre − tap
		const arg = Math.PI * d * cutoff;
		const sinc = d === 0 ? 1 : Math.sin(arg) / arg;
		k[m] = sinc * (0.5 + 0.5 * Math.cos((Math.PI * d) / RS_HALF)); // Hann taper over ±half
	}
	return k;
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

/**
 * Band-limited (windowed-sinc) resampling to SR. Only used for non-48 kHz files.
 * Integer rates use a polyphase table (44.1 kHz → 48 kHz has only 160 distinct
 * kernels); recomputing sin/cos for every tap took ~5 s per minute of audio,
 * which a 5–10 min phone recording could not afford inside maxDuration 60.
 */
export function resampleTo48k(x: Float32Array, fromRate: number): Float32Array {
	if (fromRate === SR) return x;
	if (!(fromRate > 0)) throw new Error(`invalid sample rate ${fromRate}`);
	const cutoff = Math.min(1, SR / fromRate); // low-pass below the new Nyquist when downsampling
	const integer = Number.isInteger(fromRate);
	const g = integer ? gcd(SR, fromRate) : 1;
	const up = SR / g; // output samples per `down` input samples
	const down = fromRate / g;
	// Integer arithmetic for the length so 44100 samples → exactly 48000 (float ratio can land on 47999).
	const n = integer ? Math.floor((x.length * up) / down) : Math.floor((x.length * SR) / fromRate);
	const out = new Float32Array(n);
	const table = integer && up <= 4096 ? Array.from({ length: up }, (_, ph) => rsKernel(ph / up, cutoff)) : null;
	for (let i = 0; i < n; i++) {
		let base: number;
		let k: Float64Array;
		if (table) {
			const num = i * down;
			base = Math.floor(num / up);
			k = table[num - base * up];
		} else {
			const center = (i * fromRate) / SR;
			base = Math.floor(center);
			k = rsKernel(center - base, cutoff);
		}
		const j0 = base - RS_HALF + 1;
		let acc = 0;
		let wsum = 0;
		for (let m = 0; m < 2 * RS_HALF; m++) {
			const j = j0 + m;
			if (j < 0 || j >= x.length) continue;
			acc += x[j] * k[m];
			wsum += k[m];
		}
		out[i] = wsum ? acc / wsum : 0;
	}
	return out;
}

export async function decodeRecording(
	bytes: Uint8Array,
	fileName = ''
): Promise<{ samples: Float32Array; decoder: DecoderKind; sourceRate: number; channels: number }> {
	const kind = sniffFormat(bytes, fileName);
	if (!kind) throw new NotAnalyzableError('format not analyzable yet (use m4a/aac or wav)');
	const mod = kind === 'aac' ? await import('@audio/decode-aac') : await import('@audio/decode-wav');
	const decode = (mod as unknown as { default: (b: Uint8Array) => Promise<{ channelData: Float32Array[]; sampleRate: number }> }).default;
	const { channelData, sampleRate } = await decode(bytes);
	if (!channelData?.length || !channelData[0].length) throw new Error('decoder returned no audio');
	if (!(sampleRate > 0)) throw new Error('decoder returned no sample rate');
	// Average to mono over the samples every channel has (a short channel would
	// otherwise read undefined → NaN), and zero any non-finite sample so one bad
	// frame cannot turn the whole fingerprint into NaN (not JSON-safe).
	const len = Math.min(...channelData.map((ch) => ch.length));
	const mono = new Float32Array(len);
	for (const ch of channelData) for (let i = 0; i < len; i++) mono[i] += ch[i] / channelData.length;
	for (let i = 0; i < len; i++) if (!Number.isFinite(mono[i])) mono[i] = 0;
	if (mono.length < sampleRate) throw new Error('recording is shorter than 1 second');
	return { samples: resampleTo48k(mono, sampleRate), decoder: kind, sourceRate: sampleRate, channels: channelData.length };
}
