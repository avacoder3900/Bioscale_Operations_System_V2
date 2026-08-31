/**
 * Mints a short-lived, single-key upload token so the browser can PUT a large
 * work instruction straight to the R2 Worker.
 *
 * Why this exists: Vercel caps a serverless request body at ~4.5 MB, and the
 * real SPU work instructions run well past that. The browser cannot reach the
 * S3 API endpoint (r2.cloudflarestorage.com is blocked at the network level),
 * so the Cloudflare Worker is the only reachable write path to R2.
 *
 * The browser never receives R2_UPLOAD_SECRET. It gets an HMAC over
 * "PUT\n<key>\n<exp>", which the Worker recomputes. A leaked token is good for
 * exactly one object key, for TOKEN_TTL_SECONDS.
 */
import { json, error } from '@sveltejs/kit';
import { createHmac, randomUUID } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { requirePermission } from '$lib/server/permissions';
import type { RequestHandler } from './$types';

/** Ceiling for the browser-direct path. Well above the ~33 MB real documents. */
const MAX_UPLOAD_BYTES = 60 * 1024 * 1024;
const TOKEN_TTL_SECONDS = 300;

export const POST: RequestHandler = async ({ request, locals }) => {
	requirePermission(locals.user, 'spu:write');

	const workerUrl = env.R2_WORKER_URL;
	if (!workerUrl) throw error(500, 'R2_WORKER_URL not configured');
	const uploadSecret = env.R2_UPLOAD_SECRET || 'brevitest-r2-upload-key-2026';

	const body = await request.json().catch(() => null);
	if (!body || typeof body !== 'object') throw error(400, 'Invalid JSON body');

	const fileName = String((body as any).fileName ?? '').trim();
	const size = Number((body as any).size);

	if (!fileName) throw error(400, 'fileName is required');
	if (!Number.isFinite(size) || size <= 0) throw error(400, 'size is required');
	if (size > MAX_UPLOAD_BYTES) {
		throw error(413, `File too large (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)`);
	}

	const lower = fileName.toLowerCase();
	if (!lower.endsWith('.docx') && !lower.endsWith('.pdf')) {
		throw error(400, 'Only .docx and .pdf files are supported');
	}

	const ext = lower.endsWith('.pdf') ? 'pdf' : 'docx';
	const contentType =
		ext === 'pdf'
			? 'application/pdf'
			: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

	// Server-controlled key. Never derived from client input beyond the
	// extension, so a caller cannot aim the write at an unrelated prefix.
	const key = `spu-wi/uploads/${Date.now()}-${randomUUID()}.${ext}`;

	const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
	const sig = createHmac('sha256', uploadSecret).update(`PUT\n${key}\n${exp}`).digest('hex');

	return json({
		key,
		contentType,
		expiresAt: exp,
		putUrl: `${workerUrl}/upload/${encodeURIComponent(key)}?exp=${exp}&sig=${sig}`
	});
};
