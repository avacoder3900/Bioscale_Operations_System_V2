// Outbound HTTP client for the robot-arm FastAPI server (on the Pi).
//
// Set ROBOT_ARM_BASE_URL (e.g. http://arm-pi:8000) and ROBOT_ARM_API_KEY
// in BIMS .env. The Pi-side env must have ROBOT_ARM_API_KEY matching.

import { env } from '$env/dynamic/private';

interface FetchOptions {
	method?: 'GET' | 'POST';
	body?: unknown;
	timeoutMs?: number;
}

function baseUrl(): string {
	const url = env.ROBOT_ARM_BASE_URL;
	if (!url) throw new Error('ROBOT_ARM_BASE_URL not set in env');
	return url.replace(/\/$/, '');
}

export async function robotArmFetch<T>(path: string, opts: FetchOptions = {}): Promise<T> {
	const apiKey = env.ROBOT_ARM_API_KEY;
	if (!apiKey) throw new Error('ROBOT_ARM_API_KEY not set in env');

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 5000);
	try {
		const res = await fetch(`${baseUrl()}${path}`, {
			method: opts.method ?? 'GET',
			headers: {
				'Content-Type': 'application/json',
				'x-api-key': apiKey
			},
			body: opts.body ? JSON.stringify(opts.body) : undefined,
			signal: controller.signal
		});
		const text = await res.text();
		const data = text ? JSON.parse(text) : null;
		if (!res.ok) {
			const detail =
				typeof data === 'object' && data && 'detail' in data
					? (data as { detail: unknown }).detail
					: text;
			throw new Error(
				`robot-arm ${res.status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`
			);
		}
		return data as T;
	} finally {
		clearTimeout(timeout);
	}
}

// Typed convenience wrappers for the Pi endpoints we use.
//
// Match shapes in robot-arm/src/server/app.py:
//   POST /teleop/start  body: TeleopRequest
//   POST /record/start  body: RecordRequest
//   POST /replay/start  body: ReplayRequest
//   POST /sessions/stop
//   GET  /sessions/active
//   GET  /recordings

export interface TriggeredBy {
	_id: string;
	username: string;
}

export interface ActiveSession {
	active: { run_id: string; kind: string } | null;
}

export interface SessionStarted {
	run_id: string;
	kind: 'teleop' | 'record' | 'replay';
}

export interface RecordingMeta {
	name: string;
	path: string;
	size_bytes: number;
	modified: string;
}

export const robotArm = {
	getActive: () => robotArmFetch<ActiveSession>('/sessions/active'),
	stop: () => robotArmFetch<{ stopped_run_id: string | null }>('/sessions/stop', { method: 'POST' }),
	startTeleop: (body: { rate_hz?: number; duration_s?: number; triggered_by?: TriggeredBy }) =>
		robotArmFetch<SessionStarted>('/teleop/start', { method: 'POST', body }),
	startRecord: (body: {
		name: string;
		rate_hz?: number;
		duration_s?: number;
		triggered_by?: TriggeredBy;
	}) => robotArmFetch<SessionStarted>('/record/start', { method: 'POST', body }),
	startReplay: (body: { source: string; loops?: number; triggered_by?: TriggeredBy }) =>
		robotArmFetch<SessionStarted>('/replay/start', { method: 'POST', body }),
	listRecordings: () => robotArmFetch<{ recordings: RecordingMeta[] }>('/recordings'),
	health: () => robotArmFetch<{ status: string; service: string; version: string }>('/health')
};
