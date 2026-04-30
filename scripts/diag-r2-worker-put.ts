/**
 * Probe a worker PUT directly — bypass our service code.
 * Run: npx tsx scripts/diag-r2-worker-put.ts
 */
import * as dotenv from 'dotenv';
import { Buffer } from 'node:buffer';
dotenv.config({ path: '.env.local' });
dotenv.config();

async function main() {
	const workerUrl = process.env.R2_WORKER_URL!;
	const secret = process.env.R2_UPLOAD_SECRET || 'brevitest-r2-upload-key-2026';
	const key = `cv/_diag/probe-${Date.now()}.txt`;
	const url = `${workerUrl}/upload/${encodeURIComponent(key)}`;
	const body = Buffer.from(`hello ${new Date().toISOString()}\n`);

	console.log(`PUT ${url}`);
	console.log(`  body length=${body.length}  secret length=${secret.length}`);
	try {
		const res = await fetch(url, {
			method: 'PUT',
			headers: { 'Content-Type': 'text/plain', 'X-Upload-Secret': secret },
			body
		});
		console.log(`  HTTP ${res.status}`);
		console.log(`  body=${await res.text()}`);
	} catch (err: any) {
		console.log(`  fetch failed: ${err?.message}`);
		console.log(`  cause: ${err?.cause?.message ?? err?.cause?.code ?? err?.cause}`);
	}
}
main().catch(e => { console.error(e); process.exit(1); });
