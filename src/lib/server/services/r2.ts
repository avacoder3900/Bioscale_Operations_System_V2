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
