import { env } from '$env/dynamic/private';

const BASE_URL = env.CV_WORKER_URL || 'http://localhost:8000';

async function request(path: string, options?: RequestInit) {
	const res = await fetch(`${BASE_URL}${path}`, {
		...options,
		headers: { 'Content-Type': 'application/json', ...options?.headers }
	});
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

export async function runInference(imageUrl: string, modelPath: string) {
	return request('/infer', {
		method: 'POST',
		body: JSON.stringify({ image_url: imageUrl, model_path: modelPath })
	});
}
