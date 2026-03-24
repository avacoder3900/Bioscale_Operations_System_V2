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

let _client: S3Client | null = null;

function getClient(): S3Client {
	if (_client) return _client;

	const accountId = env.R2_ACCOUNT_ID;
	if (!accountId) throw new Error('R2_ACCOUNT_ID is not configured');

	_client = new S3Client({
		region: 'auto',
		endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
		credentials: {
			accessKeyId: env.R2_ACCESS_KEY_ID!,
			secretAccessKey: env.R2_SECRET_ACCESS_KEY!
		}
	});

	return _client;
}

function getBucket(): string {
	const bucket = env.R2_BUCKET_NAME;
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
