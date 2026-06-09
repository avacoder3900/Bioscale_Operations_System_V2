/**
 * Mint a signed download URL for the smoke test image and try to fetch it.
 * If this fails or CORS-blocks the browser, the cartridge-admin photo
 * rendering will fail too.
 *
 * Run: npx tsx scripts/diag-signed-url-fetchability.ts
 */
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const KEY = 'cv/fill-3/xw2_mv_hVcVDL6LBTw50U_smoke_1777574373225.png';

async function main() {
	const accountId = process.env.R2_ACCOUNT_ID!;
	const bucket = process.env.R2_BUCKET_NAME!;
	const client = new S3Client({
		region: 'auto',
		endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
		credentials: {
			accessKeyId: process.env.R2_ACCESS_KEY_ID!,
			secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!
		},
		requestChecksumCalculation: 'WHEN_REQUIRED',
		responseChecksumValidation: 'WHEN_REQUIRED'
	});
	const url = await getSignedUrl(
		client,
		new GetObjectCommand({ Bucket: bucket, Key: KEY }),
		{ expiresIn: 3600 }
	);
	console.log('signed URL host =', new URL(url).host);
	console.log('signed URL =', url.slice(0, 200) + (url.length > 200 ? '...' : ''));

	console.log('\nTry fetch (no Origin header — like server-side):');
	try {
		const r = await fetch(url);
		console.log(`  HTTP ${r.status}  bytes=${(await r.arrayBuffer()).byteLength}`);
	} catch (err: any) {
		console.log(`  fetch failed: ${err.message}  cause=${err.cause?.message ?? err.cause?.code ?? err.cause}`);
	}

	console.log('\nTry fetch with browser-like Origin header (CORS preflight context):');
	try {
		const r = await fetch(url, {
			headers: {
				'Origin': 'http://localhost:5176',
				'Referer': 'http://localhost:5176/cartridge-admin'
			}
		});
		const acao = r.headers.get('access-control-allow-origin');
		console.log(`  HTTP ${r.status}  access-control-allow-origin=${acao ?? '(absent)'}  bytes=${(await r.arrayBuffer()).byteLength}`);
	} catch (err: any) {
		console.log(`  fetch failed: ${err.message}  cause=${err.cause?.message ?? err.cause?.code ?? err.cause}`);
	}
}
main().catch(e => { console.error(e); process.exit(1); });
