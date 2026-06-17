import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { env } from '$env/dynamic/private';

const BASE_URL = 'https://api.sync-sign.com/v2';
const DEFAULT_CONFIG_PATH = join(homedir(), '.openclaw', 'secrets', 'mocreo_config.json');

interface MocreoConfig {
	email: string;
	password: string;
}

interface TokenCache {
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
}

let tokenCache: TokenCache | null = null;

function loadConfig(): MocreoConfig {
	// Prefer env vars (works on Vercel and any host without filesystem secrets)
	if (env.MOCREO_EMAIL && env.MOCREO_PASSWORD) {
		return { email: env.MOCREO_EMAIL, password: env.MOCREO_PASSWORD };
	}

	const path = env.MOCREO_CONFIG_PATH || DEFAULT_CONFIG_PATH;
	if (!existsSync(path)) {
		throw new Error(
			`Mocreo config not found. Set MOCREO_EMAIL and MOCREO_PASSWORD env vars, ` +
				`or place a JSON file at ${path} (override with MOCREO_CONFIG_PATH).`
		);
	}
	try {
		const raw = readFileSync(path, 'utf-8');
		const parsed = JSON.parse(raw);
		if (!parsed.email || !parsed.password) {
			throw new Error(`Mocreo config at ${path} missing required "email" or "password" field.`);
		}
		return parsed;
	} catch (err: any) {
		throw new Error(`Failed to load Mocreo config from ${path}: ${err.message}`);
	}
}

async function authenticate(): Promise<string> {
	// Return cached token if still valid (with 60s buffer)
	if (tokenCache && Date.now() < tokenCache.expiresAt - 60_000) {
		return tokenCache.accessToken;
	}

	const config = loadConfig();
	let res: Response;
	try {
		res = await fetch(`${BASE_URL}/oauth/token`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				username: config.email,
				password: config.password,
				provider: 'mocreo'
			})
		});
	} catch (err: any) {
		throw new Error(`Mocreo auth network error: ${err.message}`);
	}

	if (!res.ok) {
		const detail = await res.text().catch(() => '');
		throw new Error(`Mocreo auth failed: ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`);
	}

	let body: any;
	try {
		body = await res.json();
	} catch (err: any) {
		throw new Error(`Mocreo auth: invalid JSON response — ${err.message}`);
	}
	if (!body?.data?.accessToken) {
		throw new Error(`Mocreo auth: response missing accessToken (${JSON.stringify(body).slice(0, 200)})`);
	}
	const { accessToken, refreshToken } = body.data;

	// Cache token for 55 minutes (Mocreo tokens typically last 1 hour)
	tokenCache = {
		accessToken,
		refreshToken,
		expiresAt: Date.now() + 55 * 60 * 1000
	};

	return accessToken;
}

async function apiGet(path: string): Promise<any> {
	const token = await authenticate();
	const res = await fetch(`${BASE_URL}${path}`, {
		headers: { Authorization: `Bearer ${token}` }
	});

	if (!res.ok) {
		// If 401, clear cache and retry once
		if (res.status === 401 && tokenCache) {
			tokenCache = null;
			const newToken = await authenticate();
			const retry = await fetch(`${BASE_URL}${path}`, {
				headers: { Authorization: `Bearer ${newToken}` }
			});
			if (!retry.ok) {
				const detail = await retry.text().catch(() => '');
				throw new Error(`Mocreo API error (${path}): ${retry.status} ${retry.statusText}${detail ? ` — ${detail.slice(0, 200)}` : ''}`);
			}
			return retry.json();
		}
		const detail = await res.text().catch(() => '');
		throw new Error(`Mocreo API error (${path}): ${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 200)}` : ''}`);
	}

	return res.json();
}

export interface MocreoSensor {
	thingName: string;
	name: string;
	model: string;
	info: Record<string, any>;
}

export interface MocreoSample {
	time: number;         // unix seconds
	data: {
		tm?: number;      // raw temperature
		hm?: number;      // raw humidity
	};
}

export async function fetchAllSensors(): Promise<MocreoSensor[]> {
	const body = await apiGet('/nodes');
	return (body.data ?? body) as MocreoSensor[];
}

/**
 * Convert thingName (e.g. MC30AEA4004617) to the sample-endpoint node ID format
 * (e.g. 0030aea400461700) — 16 chars, lowercase, MC→00 prefix, 00 suffix
 */
function toSampleNodeId(thingName: string): string {
	if (thingName.length >= 16 && !thingName.startsWith('MC')) return thingName;
	return '00' + thingName.slice(2).toLowerCase() + '00';
}

export async function fetchLatestReading(nodeId: string): Promise<MocreoSample | null> {
	const sampleId = toSampleNodeId(nodeId);
	const body = await apiGet(`/nodes/${encodeURIComponent(sampleId)}/samples?limit=1`);
	const records: MocreoSample[] = body.data?.records ?? [];
	return records[0] ?? null;
}

export async function fetchHistory(
	nodeId: string,
	from: number,
	to: number
): Promise<MocreoSample[]> {
	const sampleId = toSampleNodeId(nodeId);
	const body = await apiGet(
		`/nodes/${encodeURIComponent(sampleId)}/samples?startTime=${from}&endTime=${to}&limit=1000`
	);
	return body.data?.records ?? [];
}

/** Convert raw Mocreo temperature value to °C */
export function rawToC(raw: number): number {
	return raw / 100;
}

/** Convert raw Mocreo humidity value to % */
export function rawToHumidity(raw: number): number {
	return raw / 100;
}
