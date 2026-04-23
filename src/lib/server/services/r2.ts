/**
 * Cloudflare R2 Storage Service
 * 
 * Uses raw S3v4 signatures with Node built-ins (crypto, https).
 * Zero external dependencies — no AWS SDK, no sharp, no Rollup issues.
 */
import { createHmac, createHash } from 'node:crypto';
import { env } from '$env/dynamic/private';

function getConfig() {
	const accountId = env.R2_ACCOUNT_ID;
	const accessKeyId = env.R2_ACCESS_KEY_ID;
	const secretAccessKey = env.R2_SECRET_ACCESS_KEY;
	const bucket = env.R2_BUCKET_NAME || 'brevitest-cv';
	const publicUrl = env.R2_PUBLIC_URL || `https://${bucket}.r2.dev`;
	const endpoint = `${accountId}.r2.cloudflarestorage.com`;

	if (!accountId || !accessKeyId || !secretAccessKey) {
		throw new Error('R2 credentials not configured (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)');
	}

	return { accountId, accessKeyId, secretAccessKey, bucket, publicUrl, endpoint };
}

// --- S3v4 Signature Helpers (Node built-ins only) ---

function hmacSha256(key: Buffer | string, data: string): Buffer {
	return createHmac('sha256', key).update(data).digest();
}

function sha256Hex(data: string | Buffer): string {
	return createHash('sha256').update(data).digest('hex');
}

function getSignatureKey(secretKey: string, dateStamp: string, region: string, service: string): Buffer {
	const kDate = hmacSha256(`AWS4${secretKey}`, dateStamp);
	const kRegion = hmacSha256(kDate, region);
	const kService = hmacSha256(kRegion, service);
	return hmacSha256(kService, 'aws4_request');
}

function formatAmzDate(date: Date): { amzDate: string; dateStamp: string } {
	const iso = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
	return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

// --- Presigned URL (for browser-direct uploads) ---

export function getPresignedUploadUrl(key: string, contentType: string, expiresIn = 300): string {
	const cfg = getConfig();
	const region = 'auto';
	const service = 's3';
	const method = 'PUT';
	const now = new Date();
	const { amzDate, dateStamp } = formatAmzDate(now);
	const credential = `${cfg.accessKeyId}/${dateStamp}/${region}/${service}/aws4_request`;
	const host = `${cfg.endpoint}`;

	const queryParams = new URLSearchParams({
		'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
		'X-Amz-Credential': credential,
		'X-Amz-Date': amzDate,
		'X-Amz-Expires': String(expiresIn),
		'X-Amz-SignedHeaders': 'content-type;host'
	});

	// Canonical request
	const canonicalUri = `/${cfg.bucket}/${key}`;
	const canonicalQuerystring = queryParams.toString().split('&').sort().join('&');
	const canonicalHeaders = `content-type:${contentType}\nhost:${host}\n`;
	const signedHeaders = 'content-type;host';
	const payloadHash = 'UNSIGNED-PAYLOAD';

	const canonicalRequest = [
		method, canonicalUri, canonicalQuerystring,
		canonicalHeaders, signedHeaders, payloadHash
	].join('\n');

	// String to sign
	const scope = `${dateStamp}/${region}/${service}/aws4_request`;
	const stringToSign = [
		'AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)
	].join('\n');

	// Signature
	const signingKey = getSignatureKey(cfg.secretAccessKey, dateStamp, region, service);
	const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

	return `https://${host}${canonicalUri}?${canonicalQuerystring}&X-Amz-Signature=${signature}`;
}

// --- Public URL ---

export function getR2Url(key: string): string {
	const workerUrl = env.R2_WORKER_URL;
	if (workerUrl) {
		return `${workerUrl}/file/${encodeURIComponent(key)}`;
	}
	const cfg = getConfig();
	return `${cfg.publicUrl}/${key}`;
}

export function slugifyProjectName(name: string): string {
	const slug = name
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return slug || 'unnamed';
}

export function buildCvKey(projectName: string, id: string, ext: string): string {
	return `cv/${slugifyProjectName(projectName)}/${id}.${ext}`;
}

export function buildCvThumbKey(projectName: string, id: string): string {
	return `cv/${slugifyProjectName(projectName)}/thumbs/${id}.jpg`;
}

export function buildCvNamedKey(projectName: string, id: string, filename: string): string {
	const safeName = filename.replace(/[^a-zA-Z0-9_\-\.]/g, '_').slice(0, 120);
	return `cv/${slugifyProjectName(projectName)}/${id}_${safeName}`;
}

// --- Server-side operations (used by Python worker / scripts, not Vercel functions) ---
// These use fetch() which works everywhere.

export async function uploadToR2(buffer: Buffer, key: string, contentType: string): Promise<string> {
	const url = getPresignedUploadUrl(key, contentType, 600);
	const res = await fetch(url, {
		method: 'PUT',
		body: buffer,
		headers: { 'Content-Type': contentType }
	});
	if (!res.ok) {
		const text = await res.text().catch(() => '');
		throw new Error(`R2 upload failed (${res.status}): ${text}`);
	}
	return getR2Url(key);
}

/**
 * Copy an object within the bucket by going through the Cloudflare Worker:
 *   GET {R2_WORKER_URL}/file/{src} → buffer
 *   PUT {R2_WORKER_URL}/upload/{dest} with X-Upload-Secret → writes to R2
 *
 * The Worker has a native R2 binding so it bypasses the TLS issues that
 * fetch-from-Vercel-to-r2.cloudflarestorage.com hits.
 */
export async function copyViaWorker(sourceKey: string, destKey: string): Promise<void> {
	const workerUrl = env.R2_WORKER_URL;
	if (!workerUrl) throw new Error('R2_WORKER_URL not configured');
	const uploadSecret = env.R2_UPLOAD_SECRET || 'brevitest-r2-upload-key-2026';

	const dlUrl = `${workerUrl}/file/${encodeURIComponent(sourceKey)}`;
	const dlRes = await fetch(dlUrl);
	if (!dlRes.ok) {
		throw new Error(`worker download ${sourceKey} → ${dlRes.status}`);
	}
	const body = Buffer.from(await dlRes.arrayBuffer());
	const contentType = dlRes.headers.get('content-type') || 'application/octet-stream';

	const ulUrl = `${workerUrl}/upload/${encodeURIComponent(destKey)}`;
	const ulRes = await fetch(ulUrl, {
		method: 'PUT',
		headers: {
			'Content-Type': contentType,
			'X-Upload-Secret': uploadSecret
		},
		body
	});
	if (!ulRes.ok) {
		const text = await ulRes.text().catch(() => '');
		throw new Error(`worker upload ${destKey} → ${ulRes.status} ${text}`);
	}
}

/**
 * Delete an object via the Cloudflare Worker (DELETE /file/:key).
 * Worker requires X-Upload-Secret for writes/deletes.
 */
export async function deleteViaWorker(key: string): Promise<void> {
	const workerUrl = env.R2_WORKER_URL;
	if (!workerUrl) throw new Error('R2_WORKER_URL not configured');
	const uploadSecret = env.R2_UPLOAD_SECRET || 'brevitest-r2-upload-key-2026';

	const url = `${workerUrl}/file/${encodeURIComponent(key)}`;
	const res = await fetch(url, {
		method: 'DELETE',
		headers: { 'X-Upload-Secret': uploadSecret }
	});
	if (!res.ok && res.status !== 404) {
		throw new Error(`worker delete ${key} → ${res.status}`);
	}
}

/**
 * Server-side copy within the bucket via S3 CopyObject (PUT with x-amz-copy-source).
 * KNOWN ISSUE: this fails TLS handshake when called from Vercel Functions. Use
 * copyViaWorker() from Vercel. This function is kept for scripts/Python workers
 * that can talk to R2 directly.
 */
export async function copyInR2(sourceKey: string, destKey: string, expiresIn = 600): Promise<void> {
	const cfg = getConfig();
	const region = 'auto';
	const service = 's3';
	const method = 'PUT';
	const now = new Date();
	const { amzDate, dateStamp } = formatAmzDate(now);
	const credential = `${cfg.accessKeyId}/${dateStamp}/${region}/${service}/aws4_request`;
	const host = cfg.endpoint;
	const copySource = `/${cfg.bucket}/${sourceKey.split('/').map(encodeURIComponent).join('/')}`;

	const queryParams = new URLSearchParams({
		'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
		'X-Amz-Credential': credential,
		'X-Amz-Date': amzDate,
		'X-Amz-Expires': String(expiresIn),
		'X-Amz-SignedHeaders': 'host;x-amz-copy-source'
	});

	const canonicalUri = `/${cfg.bucket}/${destKey}`;
	const canonicalQuery = queryParams.toString().split('&').sort().join('&');
	const canonicalHeaders = `host:${host}\nx-amz-copy-source:${copySource}\n`;
	const signedHeaders = 'host;x-amz-copy-source';
	const payloadHash = 'UNSIGNED-PAYLOAD';
	const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
	const scope = `${dateStamp}/${region}/${service}/aws4_request`;
	const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
	const signingKey = getSignatureKey(cfg.secretAccessKey, dateStamp, region, service);
	const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
	const url = `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;

	const res = await fetch(url, {
		method: 'PUT',
		headers: { 'x-amz-copy-source': copySource }
	});
	if (!res.ok) {
		const text = await res.text().catch(() => '');
		throw new Error(`R2 copy ${sourceKey} → ${destKey} failed (${res.status}): ${text}`);
	}
}

export async function deleteFromR2(key: string): Promise<void> {
	// For delete, generate a presigned DELETE URL
	const cfg = getConfig();
	const region = 'auto';
	const service = 's3';
	const now = new Date();
	const { amzDate, dateStamp } = formatAmzDate(now);
	const credential = `${cfg.accessKeyId}/${dateStamp}/${region}/${service}/aws4_request`;
	const host = cfg.endpoint;

	const queryParams = new URLSearchParams({
		'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
		'X-Amz-Credential': credential,
		'X-Amz-Date': amzDate,
		'X-Amz-Expires': '300',
		'X-Amz-SignedHeaders': 'host'
	});

	const canonicalUri = `/${cfg.bucket}/${key}`;
	const canonicalQuerystring = queryParams.toString().split('&').sort().join('&');
	const canonicalHeaders = `host:${host}\n`;
	const canonicalRequest = ['DELETE', canonicalUri, canonicalQuerystring, canonicalHeaders, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
	const scope = `${dateStamp}/${region}/${service}/aws4_request`;
	const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
	const signingKey = getSignatureKey(cfg.secretAccessKey, dateStamp, region, service);
	const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

	const url = `https://${host}${canonicalUri}?${canonicalQuerystring}&X-Amz-Signature=${signature}`;
	const res = await fetch(url, { method: 'DELETE' });
	if (!res.ok && res.status !== 404) {
		throw new Error(`R2 delete failed (${res.status})`);
	}
}

export async function listR2Objects(_prefix: string): Promise<string[]> {
	// Listing requires more complex S3 XML parsing — defer to API-level queries via MongoDB
	return [];
}

export async function downloadFromR2(_key: string): Promise<Buffer> {
	// Use public URL for downloads
	const url = getR2Url(_key);
	const res = await fetch(url);
	if (!res.ok) throw new Error(`R2 download failed (${res.status})`);
	return Buffer.from(await res.arrayBuffer());
}

export async function generateThumbnail(buffer: Buffer): Promise<Buffer> {
	// Thumbnail generation deferred — return original resized via canvas on client side
	// or handle in Python CV worker. No sharp dependency needed.
	return buffer;
}
