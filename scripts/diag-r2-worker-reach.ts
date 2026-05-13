/**
 * Probe whether Node can reach R2_WORKER_URL.
 * Run: npx tsx scripts/diag-r2-worker-reach.ts
 */
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();

async function main() {
	const url = process.env.R2_WORKER_URL;
	if (!url) { console.log('R2_WORKER_URL not set'); return; }
	const host = new URL(url).host;
	console.log(`Testing GET ${url}/  (host=${host})`);
	try {
		const res = await fetch(url + '/');
		console.log(`  HTTP ${res.status}`);
		const body = await res.text();
		console.log(`  body[0..200]=${body.slice(0,200)}`);
	} catch (err: any) {
		console.log(`  fetch failed: ${err?.message}`);
		console.log(`  cause: ${err?.cause?.message ?? err?.cause?.code ?? err?.cause}`);
	}

	console.log(`\nTesting GET ${url}/file/nonexistent.txt`);
	try {
		const res = await fetch(url + '/file/nonexistent.txt');
		console.log(`  HTTP ${res.status}`);
	} catch (err: any) {
		console.log(`  fetch failed: ${err?.message}`);
		console.log(`  cause: ${err?.cause?.message ?? err?.cause?.code ?? err?.cause}`);
	}
}
main().catch(e => { console.error(e); process.exit(1); });
