/**
 * Cloudflare Worker — R2 Upload Proxy
 * 
 * Browser uploads here over standard HTTPS.
 * Worker writes directly to R2 via binding (same network, no TLS issues).
 * 
 * PUT /upload/:key  — upload file to R2
 * GET /file/:key    — read file from R2 (optional, can use public bucket URL)
 * DELETE /file/:key — delete file from R2
 */

interface Env {
	BUCKET: R2Bucket;
	UPLOAD_SECRET: string;
}

const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, X-Upload-Secret',
	'Access-Control-Max-Age': '86400',
};

/** Length-independent comparison, to avoid leaking the secret by timing. */
function safeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

async function hmacHex(secret: string, message: string): Promise<string> {
	const enc = new TextEncoder();
	const cryptoKey = await crypto.subtle.importKey(
		'raw',
		enc.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
	return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * A write is authorised by EITHER:
 *   - X-Upload-Secret matching UPLOAD_SECRET (server-to-server callers), or
 *   - a short-lived HMAC token scoped to one method+key:
 *       ?exp=<unix-seconds>&sig=hex(HMAC-SHA256(UPLOAD_SECRET, "METHOD\nkey\nexp"))
 *
 * The token form lets a browser upload without ever holding UPLOAD_SECRET.
 * Because the key is inside the signed message, a leaked token can only write
 * the one object it was minted for, and only until it expires.
 */
async function isAuthorized(
	request: Request,
	url: URL,
	env: Env,
	key: string
): Promise<boolean> {
	const secret = request.headers.get('X-Upload-Secret');
	if (secret && safeEqual(secret, env.UPLOAD_SECRET)) return true;

	const exp = url.searchParams.get('exp');
	const sig = url.searchParams.get('sig');
	if (!exp || !sig || !key) return false;

	const expSeconds = Number(exp);
	if (!Number.isFinite(expSeconds) || expSeconds * 1000 < Date.now()) return false;

	const expected = await hmacHex(env.UPLOAD_SECRET, `${request.method}\n${key}\n${exp}`);
	return safeEqual(sig.toLowerCase(), expected);
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		// CORS preflight
		if (request.method === 'OPTIONS') {
			return new Response(null, { headers: CORS_HEADERS });
		}

		const url = new URL(request.url);
		const path = url.pathname;

		// The key this request targets, needed before auth so a token can be
		// bound to it.
		const routeKey = path.startsWith('/upload/')
			? decodeURIComponent(path.slice('/upload/'.length))
			: path.startsWith('/file/')
				? decodeURIComponent(path.slice('/file/'.length))
				: '';

		// Auth check — required for PUT/DELETE, public for GET/HEAD
		const requiresAuth = request.method === 'PUT' || request.method === 'DELETE';
		if (requiresAuth) {
			if (!(await isAuthorized(request, url, env, routeKey))) {
				return new Response(JSON.stringify({ error: 'Unauthorized' }), {
					status: 401,
					headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
				});
			}
		}

		// PUT /upload/:key — upload to R2
		if (request.method === 'PUT' && path.startsWith('/upload/')) {
			const key = decodeURIComponent(path.slice('/upload/'.length));
			if (!key) {
				return new Response(JSON.stringify({ error: 'key is required' }), {
					status: 400,
					headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
				});
			}

			const contentType = request.headers.get('Content-Type') || 'application/octet-stream';

			await env.BUCKET.put(key, request.body, {
				httpMetadata: { contentType }
			});

			return new Response(JSON.stringify({ 
				ok: true, 
				key,
				url: `https://brevitest-cv.7bd6a45ccebc81a14aeac4cdc97030d5.r2.dev/${key}`
			}), {
				status: 200,
				headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
			});
		}

		// GET /file/:key — read from R2
		if (request.method === 'GET' && path.startsWith('/file/')) {
			const key = decodeURIComponent(path.slice('/file/'.length));
			const object = await env.BUCKET.get(key);
			if (!object) {
				return new Response('Not found', { status: 404, headers: CORS_HEADERS });
			}
			return new Response(object.body, {
				headers: {
					...CORS_HEADERS,
					'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream',
					'Cache-Control': 'public, max-age=31536000'
				}
			});
		}

		// DELETE /file/:key — delete from R2
		if (request.method === 'DELETE' && path.startsWith('/file/')) {
			const key = decodeURIComponent(path.slice('/file/'.length));
			await env.BUCKET.delete(key);
			return new Response(JSON.stringify({ ok: true }), {
				headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
			});
		}

		// Health check
		if (path === '/' || path === '/health') {
			return new Response(JSON.stringify({ status: 'ok', service: 'brevitest-r2-upload' }), {
				headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
			});
		}

		return new Response('Not found', { status: 404, headers: CORS_HEADERS });
	}
};
