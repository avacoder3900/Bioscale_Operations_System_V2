import {
	S3Client,
	PutObjectCommand,
	GetObjectCommand,
	DeleteObjectCommand,
	ListObjectsV2Command
} from '@aws-sdk/client-s3';
import sharp from 'sharp';
import {
	R2_ACCOUNT_ID,
	R2_ACCESS_KEY_ID,
	R2_SECRET_ACCESS_KEY,
	R2_BUCKET_NAME,
	R2_PUBLIC_URL
} from '$env/dynamic/private';

function getClient(): S3Client {
	if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
		throw new Error('R2 credentials not configured');
	}
	return new S3Client({
		region: 'auto',
		endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
		credentials: {
			accessKeyId: R2_ACCESS_KEY_ID,
			secretAccessKey: R2_SECRET_ACCESS_KEY
		}
	});
}

function getBucket(): string {
	return R2_BUCKET_NAME || 'brevitest-cv';
}

export function getR2Url(key: string): string {
	const base = R2_PUBLIC_URL || `https://${R2_BUCKET_NAME}.r2.dev`;
	return `${base}/${key}`;
}

export async function uploadToR2(buffer: Buffer, key: string, contentType: string): Promise<string> {
	const client = getClient();
	await client.send(new PutObjectCommand({
		Bucket: getBucket(),
		Key: key,
		Body: buffer,
		ContentType: contentType
	}));
	return getR2Url(key);
}

export async function downloadFromR2(key: string): Promise<Buffer> {
	const client = getClient();
	const response = await client.send(new GetObjectCommand({
		Bucket: getBucket(),
		Key: key
	}));
	const stream = response.Body;
	if (!stream) throw new Error(`Empty response for key: ${key}`);
	const chunks: Uint8Array[] = [];
	for await (const chunk of stream as AsyncIterable<Uint8Array>) {
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}

export async function deleteFromR2(key: string): Promise<void> {
	const client = getClient();
	await client.send(new DeleteObjectCommand({
		Bucket: getBucket(),
		Key: key
	}));
}

export async function listR2Objects(prefix: string): Promise<string[]> {
	const client = getClient();
	const response = await client.send(new ListObjectsV2Command({
		Bucket: getBucket(),
		Prefix: prefix
	}));
	return (response.Contents || []).map(obj => obj.Key!).filter(Boolean);
}

export async function generateThumbnail(buffer: Buffer): Promise<Buffer> {
	return sharp(buffer)
		.resize(256, 256, { fit: 'cover' })
		.jpeg({ quality: 80 })
		.toBuffer();
}
