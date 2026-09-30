/**
 * Minimal DSP for the sonic fingerprint: radix-2 FFT and scipy-compatible
 * windows / PSD estimates (density scaling, one-sided, constant detrend), so the
 * numbers match scipy.signal.welch / spectrogram in the Python prototype.
 */

const twiddleCache = new Map<number, { cos: Float64Array; sin: Float64Array; rev: Uint32Array }>();

function tables(n: number) {
	let t = twiddleCache.get(n);
	if (t) return t;
	if (n & (n - 1)) throw new Error(`FFT size ${n} is not a power of two`);
	const cos = new Float64Array(n / 2);
	const sin = new Float64Array(n / 2);
	for (let k = 0; k < n / 2; k++) {
		cos[k] = Math.cos((2 * Math.PI * k) / n);
		sin[k] = -Math.sin((2 * Math.PI * k) / n);
	}
	const bits = Math.log2(n);
	const rev = new Uint32Array(n);
	for (let i = 0; i < n; i++) {
		let r = 0;
		for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
		rev[i] = r;
	}
	t = { cos, sin, rev };
	twiddleCache.set(n, t);
	return t;
}

/** In-place complex FFT (iterative radix-2). */
export function fft(re: Float64Array, im: Float64Array): void {
	const n = re.length;
	const { cos, sin, rev } = tables(n);
	for (let i = 0; i < n; i++) {
		const j = rev[i];
		if (j > i) {
			let t = re[i]; re[i] = re[j]; re[j] = t;
			t = im[i]; im[i] = im[j]; im[j] = t;
		}
	}
	for (let size = 2; size <= n; size <<= 1) {
		const half = size >> 1;
		const step = n / size;
		for (let start = 0; start < n; start += size) {
			for (let k = 0; k < half; k++) {
				const wr = cos[k * step];
				const wi = sin[k * step];
				const a = start + k;
				const b = a + half;
				const tr = re[b] * wr - im[b] * wi;
				const ti = re[b] * wi + im[b] * wr;
				re[b] = re[a] - tr;
				im[b] = im[a] - ti;
				re[a] += tr;
				im[a] += ti;
			}
		}
	}
}

/** scipy.signal.get_window('hann', n) — periodic. */
export function hann(n: number): Float64Array {
	const w = new Float64Array(n);
	for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
	return w;
}

/** scipy.signal.get_window(('tukey', alpha), n) — periodic (spectrogram's default window). */
export function tukey(n: number, alpha = 0.25): Float64Array {
	const m = n + 1; // periodic = symmetric of length n+1 without the last sample
	const w = new Float64Array(n);
	const width = Math.floor((alpha * (m - 1)) / 2);
	for (let i = 0; i < n; i++) {
		if (i <= width) w[i] = 0.5 * (1 + Math.cos(Math.PI * (-1 + (2 * i) / (alpha * (m - 1)))));
		else if (i < m - width - 1) w[i] = 1;
		else w[i] = 0.5 * (1 + Math.cos(Math.PI * (-2 / alpha + 1 + (2 * i) / (alpha * (m - 1)))));
	}
	return w;
}

/**
 * One-sided PSD of one segment starting at `offset` (density scaling, constant
 * detrend), ADDED into `acc` (length n/2+1). Scratch arrays are reused.
 */
export function addSegmentPsd(
	x: ArrayLike<number>,
	offset: number,
	win: Float64Array,
	fs: number,
	acc: Float64Array,
	scratch: { re: Float64Array; im: Float64Array },
	winPower: number
): void {
	const n = win.length;
	const { re, im } = scratch;
	let mean = 0;
	for (let i = 0; i < n; i++) mean += x[offset + i];
	mean /= n;
	for (let i = 0; i < n; i++) {
		re[i] = (x[offset + i] - mean) * win[i];
		im[i] = 0;
	}
	fft(re, im);
	const scale = 1 / (fs * winPower);
	const last = n / 2;
	for (let k = 0; k <= last; k++) {
		let p = (re[k] * re[k] + im[k] * im[k]) * scale;
		if (k !== 0 && k !== last) p *= 2;
		acc[k] += p;
	}
}

export function windowPower(w: Float64Array): number {
	let s = 0;
	for (let i = 0; i < w.length; i++) s += w[i] * w[i];
	return s;
}

/** scipy.signal.welch(x, fs, nperseg) with its defaults (hann, 50 % overlap, mean). */
export function welch(x: ArrayLike<number>, fs: number, nperseg: number): { df: number; psd: Float64Array } {
	let n = 1;
	while (n * 2 <= Math.min(nperseg, x.length)) n *= 2; // power of two ≤ requested
	const win = hann(n);
	const wp = windowPower(win);
	const acc = new Float64Array(n / 2 + 1);
	const scratch = { re: new Float64Array(n), im: new Float64Array(n) };
	const step = n / 2;
	let count = 0;
	for (let off = 0; off + n <= x.length; off += step) {
		addSegmentPsd(x, off, win, fs, acc, scratch, wp);
		count++;
	}
	if (count) for (let k = 0; k < acc.length; k++) acc[k] /= count;
	return { df: fs / n, psd: acc };
}
