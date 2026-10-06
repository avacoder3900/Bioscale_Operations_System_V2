/**
 * Cloudflare R2 storage client for COC photos and documents.
 * R2 is S3-compatible, so we use the AWS SDK.
 *
 * Env vars:
 *   R2_ACCOUNT_ID        — Cloudflare account ID
 *   R2_ACCESS_KEY_ID     — R2 API token access key
 *   R2_SECRET_ACCESS_KEY — R2 API token secret
 *   R2_BUCKET_NAME       — e.g. "bioscale-coc-images"
 */
import {
	S3Client,
	PutObjectCommand,
	GetObjectCommand,
	HeadObjectCommand,
	ListObjectsV2Command
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '$env/dynamic/private';
import { resolveR2AccountIdFromEnv } from './r2-account';

let _client: S3Client | null = null;

function getClient(): S3Client {
	if (_client) return _client;

	// The account ID becomes part of the TLS hostname; a value that is not the bare 32-hex
	// Cloudflare account ID makes Cloudflare reject the handshake with TLS alert 40. The resolver
	// salvages the ID from a malformed variable or from R2_PUBLIC_URL, and throws a readable
	// error when it cannot. See r2-account.ts.
	const accountId = resolveR2AccountIdFromEnv(env);

	_client = new S3Client({
		region: 'auto',
		endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
		// Path-style keeps the bucket out of the hostname (<account>.r2.cloudflarestorage.com/<bucket>),
		// so a bucket name with a dot can never produce a hostname Cloudflare has no certificate for.
		forcePathStyle: true,
		credentials: {
			accessKeyId: (env.R2_ACCESS_KEY_ID ?? '').trim(),
			secretAccessKey: (env.R2_SECRET_ACCESS_KEY ?? '').trim()
		},
		requestChecksumCalculation: 'WHEN_REQUIRED',
		responseChecksumValidation: 'WHEN_REQUIRED'
	});

	return _client;
}

function getBucket(): string {
	const bucket = (env.R2_BUCKET_NAME ?? '').trim();
	if (!bucket) throw new Error('R2_BUCKET_NAME is not configured');
	return bucket;
}

export async function uploadFile(
	key: string,
	buffer: ArrayBuffer,
	contentType = 'application/octet-stream'
): Promise<{ key: string; size: number }> {
	const client = getClient();
	const bucket = getBucket();

	await client.send(
		new PutObjectCommand({
			Bucket: bucket,
			Key: key,
			Body: new Uint8Array(buffer),
			ContentType: contentType
		})
	);

	return { key, size: buffer.byteLength };
}

export async function downloadFile(
	key: string
): Promise<{ body: ReadableStream; contentType: string; size: number }> {
	const client = getClient();
	const bucket = getBucket();

	const res = await client.send(
		new GetObjectCommand({ Bucket: bucket, Key: key })
	);

	if (!res.Body) throw new Error(`R2 object not found: ${key}`);

	return {
		body: res.Body.transformToWebStream() as ReadableStream,
		contentType: res.ContentType ?? 'application/octet-stream',
		size: res.ContentLength ?? 0
	};
}

export async function getFileInfo(
	key: string
): Promise<{ contentType: string; size: number }> {
	const client = getClient();
	const bucket = getBucket();

	const res = await client.send(
		new HeadObjectCommand({ Bucket: bucket, Key: key })
	);

	return {
		contentType: res.ContentType ?? 'application/octet-stream',
		size: res.ContentLength ?? 0
	};
}

export async function listFolder(
	prefix: string
): Promise<{ key: string; size: number; lastModified: Date | null }[]> {
	const client = getClient();
	const bucket = getBucket();

	const res = await client.send(
		new ListObjectsV2Command({
			Bucket: bucket,
			Prefix: prefix.endsWith('/') ? prefix : `${prefix}/`
		})
	);

	return (res.Contents ?? []).map((item) => ({
		key: item.Key ?? '',
		size: item.Size ?? 0,
		lastModified: item.LastModified ?? null
	}));
}

export async function getSignedDownloadUrl(
	key: string,
	expiresIn = 3600
): Promise<string> {
	const client = getClient();
	const bucket = getBucket();

	return getSignedUrl(
		client,
		new GetObjectCommand({ Bucket: bucket, Key: key }),
		{ expiresIn }
	);
}

/** Build the R2 object key for a COC photo: coc/YYYY-MM-DD/{lotNumber}.{ext} */
export function buildCocKey(lotNumber: string, ext: string, date?: Date): string {
	const d = date ?? new Date();
	const dateStr = d.toISOString().slice(0, 10);
	return `coc/${dateStr}/${lotNumber}.${ext}`;
}

/** Build the R2 object key for a DHR photo: cv/{projectId}/dhr/{cartridgeId}/{phase}/{timestamp}-{filename} */
export function buildDhrKey(projectId: string, cartridgeId: string, phase: string, filename: string): string {
	const ts = new Date().toISOString().replace(/[:.]/g, '-');
	const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
	return `cv/${projectId}/dhr/${cartridgeId}/${phase}/${ts}-${safeFilename}`;
}

/** Build the R2 prefix for listing all photos of a cartridge: cv/{projectId}/dhr/{cartridgeId}/ */
export function buildDhrPrefix(projectId: string, cartridgeId: string, phase?: string): string {
	const base = `cv/${projectId}/dhr/${cartridgeId}`;
	return phase ? `${base}/${phase}/` : `${base}/`;
}
