/**
 * Probe whether Node can reach the CV worker.
 * Run: npx tsx scripts/diag-cv-worker-reach.ts
 */
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();

async function main() {
	const url = process.env.CV_WORKER_URL || 'http://localhost:8000';
	console.log(`CV_WORKER_URL = ${url}`);

	for (const path of ['/', '/health', '/docs']) {
		try {
			const res = await fetch(url + path);
			console.log(`  GET ${path}  HTTP ${res.status}`);
		} catch (err: any) {
			console.log(`  GET ${path}  FAILED: ${err.message}  cause=${err.cause?.code ?? err.cause?.message ?? err.cause}`);
		}
	}
}
main().catch(e => { console.error(e); process.exit(1); });
