import { env } from '$env/dynamic/private';

const BASE_URL = env.CV_WORKER_URL || 'http://localhost:8000';
const REQUEST_TIMEOUT_MS = 30_000;

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

async function attempt(path: string, options?: RequestInit): Promise<any> {
	let res: Response;
	try {
		res = await fetch(`${BASE_URL}${path}`, {
			...options,
			headers: buildHeaders(options?.headers),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
		});
	} catch (err: any) {
		if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
			const e = new Error(`CV worker timed out after ${REQUEST_TIMEOUT_MS / 1000}s at ${BASE_URL}${path}`);
			(e as any).retryable = true;
			throw e;
		}
		const cause = err?.cause?.code ?? err?.cause?.message ?? '';
		const e = new Error(`CV worker unreachable at ${BASE_URL}${path} (${cause || err?.message || 'no connection'}). Set CV_WORKER_URL or start services/cv-worker.`);
		(e as any).retryable = true;
		throw e;
	}
	if (!res.ok) {
		const text = await res.text();
		const e = new Error(`CV worker error ${res.status}: ${text}`);
		(e as any).retryable = res.status >= 500; // retry 5xx, never 4xx
		throw e;
	}
	return res.json();
}

async function request(path: string, options?: RequestInit): Promise<any> {
	try {
		return await attempt(path, options);
	} catch (err: any) {
		if (err?.retryable !== true) throw err;
		// One retry on network error / timeout / 5xx.
		return attempt(path, options);
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
	return request('/infer', {
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
