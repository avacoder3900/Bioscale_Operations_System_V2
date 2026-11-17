/**
 * BIMS API v1 — one key per calling app, valid only under `/api/v1/`.
 *
 *   Authorization: Bearer <key>
 *
 * The key that matches decides the calling app's name, which is what
 * `checkpoints.linked.via` and the audit rows carry. A separate trust domain
 * from every other key in BIMS: the agent, consumer and cron keys are never
 * accepted here, and no other route reads these variables.
 * Timing-safe comparison (SECURITY.md, "API Key Authentication").
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { ApiError } from './http';
import type { AppName } from './rules';

export const API_KEYS: readonly { envName: string; app: AppName }[] = [
	{ envName: 'BIMS_API_KEY_CONSUMER', app: 'bioscale-app' },
	{ envName: 'BIMS_API_KEY_BUSINESS', app: 'bioscale-business' },
	{ envName: 'BIMS_API_KEY_STORE', app: 'bioscale-store' }
];

/** A shorter value is treated as unset, so a placeholder can never become a key. */
export const MIN_KEY_LENGTH = 24;

/** Keys of BIMS's other machine surfaces. A v1 key set to the same value is ignored. */
const FOREIGN_KEYS = ['AGENT_API_KEY', 'CONSUMER_API_KEY', 'CRON_SECRET'];

const digest = (s: string) => createHash('sha256').update(s).digest();

type Env = Record<string, string | undefined>;

/** The app a presented key belongs to, or null. Compares against every configured key. */
export function appForKey(presented: string, vars: Env = env): AppName | null {
	const given = digest(presented);
	const foreign = new Set(FOREIGN_KEYS.map((n) => vars[n]).filter(Boolean));
	let match: AppName | null = null;
	for (const { envName, app } of API_KEYS) {
		const expected = vars[envName];
		if (!expected || expected.length < MIN_KEY_LENGTH || foreign.has(expected)) continue;
		// Digests are equal length, so the comparison leaks nothing about the key.
		if (timingSafeEqual(given, digest(expected)) && match === null) match = app;
	}
	return match;
}

const UNAUTHORIZED = 'Invalid or missing API key';

/** The calling app, or a 401. Only the `Authorization: Bearer` header is read. */
export function requireApp(request: Request, vars: Env = env): AppName {
	const header = request.headers.get('authorization') ?? '';
	const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
	if (!m) throw new ApiError(401, UNAUTHORIZED);
	const app = appForKey(m[1], vars);
	if (!app) throw new ApiError(401, UNAUTHORIZED);
	return app;
}
