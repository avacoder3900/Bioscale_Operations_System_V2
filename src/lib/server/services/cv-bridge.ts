import { env } from '$env/dynamic/private';

const BASE_URL = env.CV_WORKER_URL || 'http://localhost:8000';

async function request(path: string, options?: RequestInit) {
	let res: Response;
	try {
		res = await fetch(`${BASE_URL}${path}`, {
			...options,
			headers: { 'Content-Type': 'application/json', ...options?.headers }
		});
	} catch (err: any) {
		const cause = err?.cause?.code ?? err?.cause?.message ?? '';
		throw new Error(`CV worker unreachable at ${BASE_URL}${path} (${cause || err?.message || 'no connection'}). Set CV_WORKER_URL or start services/cv-worker.`);
	}
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`CV worker error ${res.status}: ${text}`);
	}
	return res.json();
}

export async function triggerTraining(projectId: string, config: {
	imageUrls: string[];
	labels: Record<string, string>;
	modelOutputKey: string;
}) {
	return request('/train', {
		method: 'POST',
		body: JSON.stringify({ project_id: projectId, ...config })
	});
}

export async function getTrainingStatus(projectId: string) {
	return request(`/status?project_id=${encodeURIComponent(projectId)}`);
}

export async function runInference(imageUrl: string, modelPath: string, confidenceThreshold?: number) {
	const body: Record<string, any> = { image_url: imageUrl, model_path: modelPath };
	if (typeof confidenceThreshold === 'number') body.confidence_threshold = confidenceThreshold;
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
