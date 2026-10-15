/**
 * Cloudflare Worker — R2 Upload Proxy
 * 
 * Browser uploads here over standard HTTPS.
 * Worker writes directly to R2 via binding (same network, no TLS issues).
 * 
 * PUT /upload/:key  — upload file to R2 (server-to-server, X-Upload-Secret)
 * PUT /direct/:key  — upload file to R2 from a browser with a short-lived
 *                     token minted by the app server (see below)
 * GET /file/:key    — read file from R2 (optional, can use public bucket URL)
 * HEAD /file/:key   — existence + size check (Content-Length) without the body
 * DELETE /file/:key — delete from R2
 *
 * Direct uploads: the app never hands X-Upload-Secret to a browser. Instead it
 * signs `${key}\n${expires}\n${maxBytes}` with HMAC-SHA256(UPLOAD_SECRET) and
 * the browser sends that hex digest as X-Upload-Token together with
 * X-Upload-Expires (unix seconds) and X-Upload-Max (bytes). The token is only
 * good for that one key, until that time, up to that size. Mirror of
 * src/lib/server/sonic-direct.ts in the app.
 */

interface Env {
	BUCKET: R2Bucket;
	UPLOAD_SECRET: string;
}

const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, HEAD, PUT, DELETE, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, X-Upload-Secret, X-Upload-Token, X-Upload-Expires, X-Upload-Max',
	'Access-Control-Expose-Headers': 'Content-Length, Content-Type',
	'Access-Control-Max-Age': '86400',
};

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
	});
}

async function hmacHex(secret: string, message: string): Promise<string> {
	const enc = new TextEncoder();
	const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
	return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		// CORS preflight
		if (request.method === 'OPTIONS') {
			return new Response(null, { headers: CORS_HEADERS });
		}

		const url = new URL(request.url);
		const path = url.pathname;

		// PUT /direct/:key — browser upload with a server-minted token (no shared secret)
		if (request.method === 'PUT' && path.startsWith('/direct/')) {
			const key = decodeURIComponent(path.slice('/direct/'.length));
			const token = request.headers.get('X-Upload-Token') ?? '';
			const expires = Number(request.headers.get('X-Upload-Expires') ?? '');
			const maxBytes = Number(request.headers.get('X-Upload-Max') ?? '');
			if (!key) return jsonResponse({ error: 'key is required' }, 400);
			if (!token || !Number.isFinite(expires) || !Number.isFinite(maxBytes)) {
				return jsonResponse({ error: 'X-Upload-Token, X-Upload-Expires and X-Upload-Max are required' }, 400);
			}
			if (expires < Math.floor(Date.now() / 1000)) return jsonResponse({ error: 'upload token expired' }, 401);
			const expected = await hmacHex(env.UPLOAD_SECRET, `${key}\n${expires}\n${maxBytes}`);
			if (!timingSafeEqual(token, expected)) return jsonResponse({ error: 'Unauthorized' }, 401);

			// R2 needs a known length for a streamed body, and it is also the size gate.
			const length = Number(request.headers.get('Content-Length') ?? '');
			if (!Number.isFinite(length) || length <= 0) return jsonResponse({ error: 'Content-Length is required' }, 411);
			if (length > maxBytes) return jsonResponse({ error: `body is ${length} bytes, token allows ${maxBytes}` }, 413);

			const contentType = request.headers.get('Content-Type') || 'application/octet-stream';
			const object = await env.BUCKET.put(key, request.body, { httpMetadata: { contentType } });
			return jsonResponse({ ok: true, key, size: object.size });
		}

		// Auth check — required for PUT/DELETE, public for GET/HEAD
		const requiresAuth = request.method === 'PUT' || request.method === 'DELETE';
		if (requiresAuth) {
			const secret = request.headers.get('X-Upload-Secret');
			if (secret !== env.UPLOAD_SECRET) {
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

		// HEAD /file/:key — existence and size without the body
		if (request.method === 'HEAD' && path.startsWith('/file/')) {
			const key = decodeURIComponent(path.slice('/file/'.length));
			const head = await env.BUCKET.head(key);
			if (!head) {
				return new Response(null, { status: 404, headers: CORS_HEADERS });
			}
			return new Response(null, {
				headers: {
					...CORS_HEADERS,
					'Content-Type': head.httpMetadata?.contentType || 'application/octet-stream',
					'Content-Length': String(head.size)
				}
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
