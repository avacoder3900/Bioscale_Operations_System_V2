/**
 * Direct-to-Worker upload for sonic recordings.
 *
 * Vercel drops any function request body over 4.5 MB, so a phone recording of a
 * full run can never be proxied through +page.server.ts. Instead the browser PUTs
 * the file straight to the Cloudflare R2 Worker (services/r2-upload-worker), which
 * takes bodies up to 100 MB. The Worker's static X-Upload-Secret must never reach
 * a browser, so this module mints a short-lived token bound to one object key and
 * one maximum size:
 *
 *   token = hex(HMAC-SHA256(R2_UPLOAD_SECRET, `${key}\n${expires}\n${maxBytes}`))
 *
 * The Worker recomputes it under PUT /direct/:key (see the Worker source) and
 * refuses anything expired, mis-keyed, or larger than maxBytes. After the PUT the
 * page calls the `record` action, which HEADs the object through the Worker before
 * writing the session, so a record can never point at a file that is not there.
 *
 * Enable with SONIC_DIRECT_UPLOAD=1 once the Worker with /direct/ is deployed;
 * without the flag the page keeps proxying (and the 4.5 MB cap).
 */
import { env } from '$env/dynamic/private';

export const DIRECT_MAX_BYTES = 80 * 1024 * 1024;
const TOKEN_TTL_SEC = 15 * 60;

function workerUrl(): string | null {
	const u = (env.R2_WORKER_URL ?? '').trim().replace(/\/+$/, '');
	return u || null;
}

function uploadSecret(): string {
	return env.R2_UPLOAD_SECRET || 'brevitest-r2-upload-key-2026';
}

export function directUploadEnabled(): boolean {
	return !!workerUrl() && (env.SONIC_DIRECT_UPLOAD ?? '').trim() === '1';
}

async function hmacHex(secret: string, message: string): Promise<string> {
	const enc = new TextEncoder();
	const cryptoKey = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
	return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface DirectUploadGrant {
	url: string;
	token: string;
	expires: number;
	maxBytes: number;
	key: string;
}

export async function mintDirectUploadToken(key: string, maxBytes = DIRECT_MAX_BYTES): Promise<DirectUploadGrant> {
	const base = workerUrl();
	if (!base) throw new Error('R2_WORKER_URL not configured');
	const expires = Math.floor(Date.now() / 1000) + TOKEN_TTL_SEC;
	const token = await hmacHex(uploadSecret(), `${key}\n${expires}\n${maxBytes}`);
	return { url: `${base}/direct/${encodeURIComponent(key)}`, token, expires, maxBytes, key };
}

/** HEAD the object through the Worker. Null when it is not there. */
export async function headWorkerObject(key: string): Promise<{ size: number; contentType: string } | null> {
	const base = workerUrl();
	if (!base) throw new Error('R2_WORKER_URL not configured');
	const res = await fetch(`${base}/file/${encodeURIComponent(key)}`, { method: 'HEAD' });
	if (res.status === 404) return null;
	if (!res.ok) throw new Error(`worker HEAD ${key} → ${res.status}`);
	const size = Number(res.headers.get('content-length') ?? '');
	if (!Number.isFinite(size)) throw new Error(`worker HEAD ${key} returned no Content-Length (deploy the Worker with HEAD /file/ support)`);
	return { size, contentType: res.headers.get('content-type') ?? 'application/octet-stream' };
}
