/**
 * Server-side CV API fetch wrapper.
 * All calls to the ICast Computer Vision API go through this module.
 * The CV_API_KEY is never exposed to the browser.
 */
import { env } from '$env/dynamic/private';

function getBaseUrl(): string {
	return env.CV_API_URL || 'http://localhost:8000';
}

function getApiKey(): string {
	return env.CV_API_KEY || '';
}

interface CvFetchOptions {
	method?: string;
	body?: unknown;
	params?: Record<string, string>;
}

export async function cvFetch<T>(path: string, opts: CvFetchOptions = {}): Promise<T> {
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
		throw new Error((detail as Record<string, string>).detail ?? `CV API ${res.status}`);
	}

	return res.json() as Promise<T>;
}

/** Build full image URL for the CV API */
export function cvImageUrl(imageId: string): string {
	return `${getBaseUrl()}/api/v1/images/${imageId}/file`;
}

/** Build thumbnail URL for the CV API */
export function cvThumbUrl(imageId: string): string {
	return `${getBaseUrl()}/api/v1/images/${imageId}/thumbnail`;
}
