/** numpy/scipy-compatible helpers used by the sonic fingerprint (VALIDATION-08). */

export function db(v: number, floor = 1e-12): number {
	return 10 * Math.log10(Math.max(v, floor));
}

/** numpy.percentile default (linear). NaNs are ignored. */
export function percentile(values: ArrayLike<number>, p: number): number {
	const a = Array.from(values).filter((v) => !Number.isNaN(v)).sort((x, y) => x - y);
	if (!a.length) return NaN;
	const idx = (p / 100) * (a.length - 1);
	const lo = Math.floor(idx);
	const hi = Math.ceil(idx);
	return a[lo] + (a[hi] - a[lo]) * (idx - lo);
}

export function median(values: ArrayLike<number>): number {
	return percentile(values, 50);
}

export function mean(values: ArrayLike<number>): number {
	let s = 0;
	let n = 0;
	for (let i = 0; i < values.length; i++) {
		if (!Number.isNaN(values[i])) {
			s += values[i];
			n++;
		}
	}
	return n ? s / n : NaN;
}

/** Sample standard deviation (ddof=1). */
export function std1(values: ArrayLike<number>): number {
	const m = mean(values);
	let s = 0;
	let n = 0;
	for (let i = 0; i < values.length; i++) {
		if (!Number.isNaN(values[i])) {
			s += (values[i] - m) ** 2;
			n++;
		}
	}
	return n > 1 ? Math.sqrt(s / (n - 1)) : 0;
}

/** scipy.signal.medfilt — odd kernel, zero-padded edges. */
export function medfilt(x: ArrayLike<number>, kernel: number): Float64Array {
	const k = kernel | 1;
	const h = (k - 1) / 2;
	const out = new Float64Array(x.length);
	const win = new Float64Array(k);
	for (let i = 0; i < x.length; i++) {
		for (let j = -h; j <= h; j++) {
			const idx = i + j;
			win[j + h] = idx < 0 || idx >= x.length ? 0 : x[idx];
		}
		const s = Array.from(win).sort((a, b) => a - b);
		out[i] = s[h];
	}
	return out;
}

/** numpy.convolve(p, ones(k)/k, mode='same'). */
export function movingAverageSame(p: ArrayLike<number>, k: number): Float64Array {
	const n = p.length;
	const out = new Float64Array(n);
	const shift = Math.floor((k - 1) / 2);
	for (let i = 0; i < n; i++) {
		const m = i + shift; // index into the 'full' convolution
		let s = 0;
		for (let j = 0; j < k; j++) {
			const idx = m - j;
			if (idx >= 0 && idx < n) s += p[idx];
		}
		out[i] = s / k;
	}
	return out;
}

export interface Peak {
	index: number;
	prominence: number;
}

/**
 * scipy.signal.find_peaks with height / prominence (no wlen, no distance):
 * plateaus report their middle sample; prominence uses scipy's base search.
 */
export function findPeaks(y: ArrayLike<number>, opts: { height?: number; prominence?: number } = {}): Peak[] {
	const n = y.length;
	const peaks: number[] = [];
	let i = 1;
	while (i < n - 1) {
		if (y[i - 1] < y[i]) {
			let ahead = i + 1;
			while (ahead < n - 1 && y[ahead] === y[i]) ahead++;
			if (y[ahead] < y[i]) {
				peaks.push(Math.floor((i + ahead - 1) / 2));
				i = ahead;
			}
		}
		i++;
	}
	const out: Peak[] = [];
	for (const p of peaks) {
		if (opts.height != null && !(y[p] >= opts.height)) continue;
		let leftMin = y[p];
		for (let j = p - 1; j >= 0 && y[j] <= y[p]; j--) if (y[j] < leftMin) leftMin = y[j];
		let rightMin = y[p];
		for (let j = p + 1; j < n && y[j] <= y[p]; j++) if (y[j] < rightMin) rightMin = y[j];
		const prominence = y[p] - Math.max(leftMin, rightMin);
		if (opts.prominence != null && !(prominence >= opts.prominence)) continue;
		out.push({ index: p, prominence });
	}
	return out;
}

export const r1 = (v: number) => Math.round(v * 10) / 10;
