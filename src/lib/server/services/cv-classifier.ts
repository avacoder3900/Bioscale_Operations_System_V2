/**
 * In-process cartridge accept/reject classifier.
 *
 * Pipeline:
 *   image bytes -> sharp 224x224 RGB raw -> 156-dim feature vector
 *                                        -> z-score standardize
 *                                        -> logistic regression -> p(approved)
 *
 * Features (156 total, all in roughly [0,1] before standardization):
 *   - 12  per-channel global stats (mean/std/min/max for R,G,B)
 *   - 96  color histograms (32 bins x 3 channels, channel-normalized)
 *   - 48  4x4 spatial grid mean RGB
 *
 * Designed so `embedImage` is the only swap point if we later upgrade to an
 * ONNX CNN embedding. EMBEDDING_VERSION bumps will force re-embedding because
 * cv-bridge gates on a version match.
 */
import sharp from 'sharp';

export const EMBEDDING_VERSION = 'cv-color-spatial-v1';
const HIST_BINS = 32;
const GRID = 4;
const IMG_SIZE = 224;
export const EMBEDDING_DIM = 3 * 4 + HIST_BINS * 3 + GRID * GRID * 3; // 12 + 96 + 48 = 156

export interface Classifier {
	weights: number[];
	bias: number;
	featureMeans: number[];
	featureStds: number[];
	calibrationMin: number;
	calibrationMax: number;
	samplesUsed: number;
	approvedCount: number;
	rejectedCount: number;
	embeddingDim: number;
	embeddingVersion: string;
	trainedAt: Date;
	trainingLogLoss: number;
	trainingAccuracy: number;
}

export async function fetchImageBytes(url: string): Promise<Buffer> {
	const res = await fetch(url);
	if (!res.ok) {
		throw new Error(`fetchImageBytes failed: ${res.status} ${res.statusText} for ${url}`);
	}
	return Buffer.from(await res.arrayBuffer());
}

export async function embedImage(bytes: Buffer): Promise<number[]> {
	const { data, info } = await sharp(bytes)
		.resize(IMG_SIZE, IMG_SIZE, { fit: 'cover' })
		.removeAlpha()
		.raw()
		.toBuffer({ resolveWithObject: true });

	const channels = info.channels;
	if (channels !== 3) {
		throw new Error(`embedImage expected 3 channels after removeAlpha, got ${channels}`);
	}
	const W = info.width;
	const H = info.height;
	const N = W * H;
	const features: number[] = new Array(EMBEDDING_DIM);
	let f = 0;

	// 1) Per-channel global stats (mean, std, min, max) — 12 features
	for (let c = 0; c < 3; c++) {
		let sum = 0;
		let sumSq = 0;
		let min = 255;
		let max = 0;
		for (let i = 0; i < N; i++) {
			const v = data[i * 3 + c];
			sum += v;
			sumSq += v * v;
			if (v < min) min = v;
			if (v > max) max = v;
		}
		const mean = sum / N;
		const variance = Math.max(0, sumSq / N - mean * mean);
		features[f++] = mean / 255;
		features[f++] = Math.sqrt(variance) / 255;
		features[f++] = min / 255;
		features[f++] = max / 255;
	}

	// 2) Color histograms (32 bins per channel, channel-normalized) — 96 features
	const hist = new Float64Array(HIST_BINS * 3);
	const binSize = 256 / HIST_BINS;
	for (let i = 0; i < N; i++) {
		const idx = i * 3;
		for (let c = 0; c < 3; c++) {
			let b = Math.floor(data[idx + c] / binSize);
			if (b >= HIST_BINS) b = HIST_BINS - 1;
			hist[c * HIST_BINS + b] += 1;
		}
	}
	for (let c = 0; c < 3; c++) {
		for (let b = 0; b < HIST_BINS; b++) {
			features[f++] = hist[c * HIST_BINS + b] / N;
		}
	}

	// 3) 4x4 spatial grid mean RGB — 48 features
	const cellW = W / GRID;
	const cellH = H / GRID;
	for (let gy = 0; gy < GRID; gy++) {
		const y0 = Math.floor(gy * cellH);
		const y1 = Math.floor((gy + 1) * cellH);
		for (let gx = 0; gx < GRID; gx++) {
			const x0 = Math.floor(gx * cellW);
			const x1 = Math.floor((gx + 1) * cellW);
			let sR = 0;
			let sG = 0;
			let sB = 0;
			let count = 0;
			for (let y = y0; y < y1; y++) {
				const row = y * W;
				for (let x = x0; x < x1; x++) {
					const idx = (row + x) * 3;
					sR += data[idx];
					sG += data[idx + 1];
					sB += data[idx + 2];
					count++;
				}
			}
			features[f++] = sR / count / 255;
			features[f++] = sG / count / 255;
			features[f++] = sB / count / 255;
		}
	}

	if (f !== EMBEDDING_DIM) {
		throw new Error(`embedImage produced ${f} features, expected ${EMBEDDING_DIM}`);
	}
	return features;
}

function standardize(X: number[][]): { Z: number[][]; means: number[]; stds: number[] } {
	const n = X.length;
	const d = X[0].length;
	const means = new Array<number>(d).fill(0);
	const stds = new Array<number>(d).fill(0);
	for (let j = 0; j < d; j++) {
		let s = 0;
		for (let i = 0; i < n; i++) s += X[i][j];
		means[j] = s / n;
	}
	for (let j = 0; j < d; j++) {
		let s = 0;
		for (let i = 0; i < n; i++) {
			const dx = X[i][j] - means[j];
			s += dx * dx;
		}
		stds[j] = Math.sqrt(s / n) || 1; // guard zero-variance features
	}
	const Z: number[][] = new Array(n);
	for (let i = 0; i < n; i++) {
		const z = new Array<number>(d);
		for (let j = 0; j < d; j++) z[j] = (X[i][j] - means[j]) / stds[j];
		Z[i] = z;
	}
	return { Z, means, stds };
}

function sigmoid(z: number): number {
	if (z >= 0) {
		const ez = Math.exp(-z);
		return 1 / (1 + ez);
	}
	const ez = Math.exp(z);
	return ez / (1 + ez);
}

export function fitClassifier(X: number[][], y: number[]): Classifier {
	const n = X.length;
	if (n === 0) throw new Error('fitClassifier got no samples');
	const d = X[0].length;
	if (d !== EMBEDDING_DIM) {
		throw new Error(`fitClassifier expected ${EMBEDDING_DIM}-dim features, got ${d}`);
	}

	const { Z, means, stds } = standardize(X);

	let weights = new Array<number>(d).fill(0);
	let bias = 0;
	const lr = 0.1;
	const epochs = 400;
	const lambda = 0.01;

	const approvedCount = y.reduce((acc, v) => acc + (v === 1 ? 1 : 0), 0);
	const rejectedCount = n - approvedCount;
	// Class weights to counter imbalance: inverse-frequency.
	const wPos = approvedCount > 0 ? n / (2 * approvedCount) : 1;
	const wNeg = rejectedCount > 0 ? n / (2 * rejectedCount) : 1;

	for (let e = 0; e < epochs; e++) {
		const gradW = new Array<number>(d).fill(0);
		let gradB = 0;
		for (let i = 0; i < n; i++) {
			let zScore = bias;
			const zi = Z[i];
			for (let j = 0; j < d; j++) zScore += weights[j] * zi[j];
			const p = sigmoid(zScore);
			const w = y[i] === 1 ? wPos : wNeg;
			const err = w * (p - y[i]);
			gradB += err;
			for (let j = 0; j < d; j++) gradW[j] += err * zi[j];
		}
		bias -= (lr * gradB) / n;
		for (let j = 0; j < d; j++) {
			weights[j] = weights[j] - lr * (gradW[j] / n + lambda * weights[j]);
		}
	}

	// Training metrics + calibration range.
	let correct = 0;
	let logLoss = 0;
	let minP = 1;
	let maxP = 0;
	for (let i = 0; i < n; i++) {
		let zScore = bias;
		const zi = Z[i];
		for (let j = 0; j < d; j++) zScore += weights[j] * zi[j];
		const p = sigmoid(zScore);
		if (p < minP) minP = p;
		if (p > maxP) maxP = p;
		const pred = p >= 0.5 ? 1 : 0;
		if (pred === y[i]) correct++;
		const pSafe = Math.min(1 - 1e-7, Math.max(1e-7, p));
		logLoss += -(y[i] * Math.log(pSafe) + (1 - y[i]) * Math.log(1 - pSafe));
	}

	return {
		weights,
		bias,
		featureMeans: means,
		featureStds: stds,
		calibrationMin: minP,
		calibrationMax: maxP,
		samplesUsed: n,
		approvedCount,
		rejectedCount,
		embeddingDim: d,
		embeddingVersion: EMBEDDING_VERSION,
		trainedAt: new Date(),
		trainingLogLoss: logLoss / n,
		trainingAccuracy: correct / n
	};
}

export interface PredictResult {
	verdict: 'pass' | 'fail';
	percentConfidence: number;
	passProbability: number;
}

export function predict(
	embedding: number[],
	classifier: Classifier,
	threshold: number
): PredictResult {
	const d = classifier.weights.length;
	if (embedding.length !== d) {
		throw new Error(`predict embedding dim ${embedding.length} != classifier dim ${d}`);
	}
	const means = classifier.featureMeans;
	const stds = classifier.featureStds;
	if (!means || !stds || means.length !== d || stds.length !== d) {
		throw new Error('predict: classifier is missing featureMeans/featureStds — retrain');
	}

	let zScore = classifier.bias;
	for (let j = 0; j < d; j++) {
		const zj = (embedding[j] - means[j]) / (stds[j] || 1);
		zScore += classifier.weights[j] * zj;
	}
	const passProbability = sigmoid(zScore);
	const verdict: 'pass' | 'fail' = passProbability >= threshold ? 'pass' : 'fail';

	// Distance from threshold, scaled into [0,1], then to percent.
	const span = verdict === 'pass' ? Math.max(1e-6, 1 - threshold) : Math.max(1e-6, threshold);
	const dist = verdict === 'pass' ? passProbability - threshold : threshold - passProbability;
	const percentConfidence = Math.round(Math.max(0, Math.min(1, dist / span)) * 100);

	return { verdict, percentConfidence, passProbability };
}
