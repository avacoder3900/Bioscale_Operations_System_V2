/**
 * CV API fetch wrapper — all calls to the ICast Computer Vision API go through here.
 * Server-side only (keeps CV_API_KEY secret).
 */
import { env } from '$env/dynamic/private';
import type {
	ImageResponse,
	InspectionResponse,
	SampleResponse,
	CameraInfo,
	CaptureAndInspectResponse,
	DashboardStats
} from '$lib/types/cv';

function getBaseUrl(): string {
	return env.CV_API_URL || 'http://localhost:8000';
}

function getApiKey(): string {
	return env.CV_API_KEY || '';
}

interface FetchOptions {
	method?: string;
	body?: unknown;
	params?: Record<string, string>;
}

export async function cvFetch<T>(path: string, opts: FetchOptions = {}): Promise<T> {
	const base = getBaseUrl();
	const url = new URL(path, base);
	if (opts.params) {
		for (const [k, v] of Object.entries(opts.params)) {
			url.searchParams.set(k, v);
		}
	}

	const headers: Record<string, string> = {
		'Content-Type': 'application/json'
	};
	const apiKey = getApiKey();
	if (apiKey) {
		headers['X-API-Key'] = apiKey;
	}

	const res = await fetch(url.toString(), {
		method: opts.method ?? 'GET',
		headers,
		body: opts.body ? JSON.stringify(opts.body) : undefined
	});

	if (!res.ok) {
		const detail = await res.json().catch(() => ({}));
		throw new Error(detail.detail ?? `CV API ${res.status}`);
	}

	return res.json() as Promise<T>;
}

/** Build a public image URL */
export function cvImageUrl(imageId: string): string {
	return `${getBaseUrl()}/api/v1/images/${imageId}/file`;
}

/** Build a public thumbnail URL */
export function cvThumbUrl(imageId: string): string {
	return `${getBaseUrl()}/api/v1/images/${imageId}/thumbnail`;
}

// --- Typed API methods ---

export async function getSamples(skip = 0, limit = 50): Promise<SampleResponse[]> {
	return cvFetch<SampleResponse[]>('/api/v1/samples', {
		params: { skip: String(skip), limit: String(limit) }
	});
}

export async function getSample(id: string): Promise<SampleResponse> {
	return cvFetch<SampleResponse>(`/api/v1/samples/${id}`);
}

export async function getImages(params: {
	sample_id?: string;
	cartridge_id?: string;
	skip?: number;
	limit?: number;
}): Promise<ImageResponse[]> {
	const p: Record<string, string> = {};
	if (params.sample_id) p.sample_id = params.sample_id;
	if (params.cartridge_id) p.cartridge_id = params.cartridge_id;
	if (params.skip !== undefined) p.skip = String(params.skip);
	if (params.limit !== undefined) p.limit = String(params.limit);
	return cvFetch<ImageResponse[]>('/api/v1/images', { params: p });
}

export async function tagImage(
	imageId: string,
	tag: { cartridge_record_id: string; phase: string; labels: string[]; notes?: string }
): Promise<ImageResponse> {
	return cvFetch<ImageResponse>(`/api/v1/images/${imageId}/tags`, {
		method: 'POST',
		body: tag
	});
}

export async function getCameras(): Promise<CameraInfo[]> {
	return cvFetch<CameraInfo[]>('/api/v1/cameras');
}

export async function getInspections(sampleId: string): Promise<InspectionResponse[]> {
	return cvFetch<InspectionResponse[]>('/api/inspections', {
		params: { sample_id: sampleId }
	});
}

export async function getInspection(id: string): Promise<InspectionResponse> {
	return cvFetch<InspectionResponse>(`/api/inspections/${id}`);
}

export async function pollInspection(id: string): Promise<InspectionResponse> {
	return cvFetch<InspectionResponse>(`/api/inspections/${id}/poll`);
}

export async function captureAndInspect(
	sampleId: string,
	body: { camera_index?: number; inspection_type?: string; metadata?: Record<string, unknown> }
): Promise<CaptureAndInspectResponse> {
	return cvFetch<CaptureAndInspectResponse>(
		`/api/v1/samples/${sampleId}/capture-and-inspect`,
		{ method: 'POST', body }
	);
}

export async function getInspectionsByCartridge(
	cartridgeId: string
): Promise<InspectionResponse[]> {
	return cvFetch<InspectionResponse[]>(`/api/v1/inspections/cartridge/${cartridgeId}`);
}

export async function getDashboardStats(): Promise<DashboardStats> {
	return cvFetch<DashboardStats>('/api/v1/dashboard/stats');
}

export async function getAllInspections(params: {
	skip?: number;
	limit?: number;
}): Promise<InspectionResponse[]> {
	const p: Record<string, string> = {};
	if (params.skip !== undefined) p.skip = String(params.skip);
	if (params.limit !== undefined) p.limit = String(params.limit);
	return cvFetch<InspectionResponse[]>('/api/v1/inspections', { params: p });
}
