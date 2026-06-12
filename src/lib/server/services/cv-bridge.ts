import { env } from '$env/dynamic/private';

const BASE_URL = env.CV_WORKER_URL || 'http://localhost:8000';
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Inference target resolution. Inference is serverless-first: the Vercel
 * Python function api/ml/infer.py deploys with the app and serves
 * /api/ml/infer on the same domain, so no standalone worker is needed.
 *  1. CV_INFER_URL        — explicit override (full URL to the infer endpoint)
 *  2. https://$VERCEL_URL — same-deployment function (any Vercel deploy)
 *  3. ${CV_WORKER_URL}/infer — legacy standalone worker / local dev fallback
 */
function inferUrl(): string {
	if (env.CV_INFER_URL) return env.CV_INFER_URL;
	if (env.VERCEL_URL) return `https://${env.VERCEL_URL}/api/ml/infer`;
	return `${BASE_URL}/infer`;
}

let warnedNoSecret = false;

function buildHeaders(extra?: HeadersInit): Record<string, string> {
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (extra) {
		new Headers(extra).forEach((value, key) => { headers[key] = value; });
	}
	const secret = env.CV_WORKER_SECRET;
	if (secret) {
		headers['X-CV-Secret'] = secret;
	} else if (!warnedNoSecret) {
		warnedNoSecret = true;
		console.warn('[cv-bridge] CV_WORKER_SECRET is not set — sending unauthenticated requests to the CV worker (ok for local dev only)');
	}
	return headers;
}

async function attempt(url: string, options?: RequestInit): Promise<any> {
	let res: Response;
	try {
		res = await fetch(url, {
			...options,
			headers: buildHeaders(options?.headers),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
		});
	} catch (err: any) {
		if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
			const e = new Error(`CV endpoint timed out after ${REQUEST_TIMEOUT_MS / 1000}s at ${url}`);
			(e as any).retryable = true;
			throw e;
		}
		const cause = err?.cause?.code ?? err?.cause?.message ?? '';
		const e = new Error(`CV endpoint unreachable at ${url} (${cause || err?.message || 'no connection'}). Set CV_INFER_URL/CV_WORKER_URL or start services/cv-worker.`);
		(e as any).retryable = true;
		throw e;
	}
	if (!res.ok) {
		const text = await res.text();
		const e = new Error(`CV endpoint error ${res.status} at ${url}: ${text}`);
		(e as any).retryable = res.status >= 500; // retry 5xx, never 4xx
		throw e;
	}
	return res.json();
}

/** pathOrUrl: worker-relative path ('/train') or a full URL ('https://…/api/ml/infer'). */
async function request(pathOrUrl: string, options?: RequestInit): Promise<any> {
	const url = pathOrUrl.startsWith('/') ? `${BASE_URL}${pathOrUrl}` : pathOrUrl;
	try {
		return await attempt(url, options);
	} catch (err: any) {
		if (err?.retryable !== true) throw err;
		// One retry on network error / timeout / 5xx.
		return attempt(url, options);
	}
}

export async function triggerTraining(projectId: string, config: {
	imageUrls: string[];
	labels: Record<string, string>;
	modelOutputKey: string;
	/** trainedModels[] version this run mints — the worker reports it back via
	 *  POST /api/cv/train-complete. Falls back to the modelOutputKey filename stem. */
	version?: string;
}) {
	return request('/train', {
		method: 'POST',
		body: JSON.stringify({ project_id: projectId, ...config })
	});
}

export async function getTrainingStatus(projectId: string) {
	return request(`/status?project_id=${encodeURIComponent(projectId)}`);
}

export async function runInference(
	imageUrl: string,
	modelPath: string,
	confidenceThreshold?: number,
	scoreStats?: { rawMin: number; rawMax: number }
) {
	const body: Record<string, any> = { image_url: imageUrl, model_path: modelPath };
	if (typeof confidenceThreshold === 'number') body.confidence_threshold = confidenceThreshold;
	if (scoreStats) body.score_stats = { rawMin: scoreStats.rawMin, rawMax: scoreStats.rawMax };
	return request(inferUrl(), {
		method: 'POST',
		body: JSON.stringify(body)
	});
}

export async function processImage(imageUrl: string, outputKey: string, mode: 'full' | 'raw' = 'full', params?: Record<string, number>) {
	return request('/process-image', {
		method: 'POST',
		body: JSON.stringify({ image_url: imageUrl, output_key: outputKey, mode, params: params || {} })
	});
}
