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

/** Band-limited (windowed-sinc) resampling to SR. Only used for non-48 kHz files. */
export function resampleTo48k(x: Float32Array, fromRate: number): Float32Array {
	if (fromRate === SR) return x;
	const ratio = SR / fromRate;
	const n = Math.floor(x.length * ratio);
	const out = new Float32Array(n);
	const cutoff = Math.min(1, ratio); // low-pass below the new Nyquist when downsampling
	const half = 16;
	for (let i = 0; i < n; i++) {
		const center = i / ratio;
		const j0 = Math.floor(center) - half + 1;
		let acc = 0;
		let wsum = 0;
		for (let j = j0; j < j0 + 2 * half; j++) {
			if (j < 0 || j >= x.length) continue;
			const d = center - j;
			const arg = Math.PI * d * cutoff;
			const sinc = d === 0 ? 1 : Math.sin(arg) / arg;
			const w = 0.5 + 0.5 * Math.cos((Math.PI * d) / half); // Hann taper over ±half
			const k = sinc * w;
			acc += x[j] * k;
			wsum += k;
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
	let mono: Float32Array;
	if (channelData.length === 1) mono = channelData[0];
	else {
		mono = new Float32Array(channelData[0].length);
		for (const ch of channelData) for (let i = 0; i < mono.length; i++) mono[i] += ch[i] / channelData.length;
	}
	if (mono.length < sampleRate) throw new Error('recording is shorter than 1 second');
	return { samples: resampleTo48k(mono, sampleRate), decoder: kind, sourceRate: sampleRate, channels: channelData.length };
}
