/**
 * Smoke test for /api/cv/capture-ingest.
 * Reads AGENT_API_KEY from env and POSTs a 1x1 PNG.
 * Run: npx tsx scripts/smoke-capture-ingest.ts
 */
import * as dotenv from 'dotenv';
import { Buffer } from 'node:buffer';
dotenv.config({ path: '.env.local' });
dotenv.config();

const BASE = process.env.SMOKE_BASE_URL || 'http://localhost:5176';
const KEY = process.env.AGENT_API_KEY;
const QR = process.env.SMOKE_QR || '382579ef-4975-40f6-a5cc-65dfd9ba6eb0';
const PROJECT = process.env.SMOKE_PROJECT_ID || 'lf97luxknyI9lCkvM2MW7';
const PHASE = process.env.SMOKE_PHASE || 'wax_filled';

if (!KEY) { console.error('AGENT_API_KEY not set'); process.exit(1); }

async function main() {
	// Minimal valid 1x1 red PNG (67 bytes, hand-crafted)
	const png = Buffer.from(
		'89504E470D0A1A0A0000000D49484452000000010000000108020000009077533D' +
		'0000000C49444154789C63F8CFC0000000030001005AFD747F0000000049454E44' +
		'AE426082',
		'hex'
	);

	const fd = new FormData();
	fd.append('file', new Blob([png], { type: 'image/png' }), `smoke_${Date.now()}.png`);
	fd.append('qrCode', QR);
	fd.append('phase', PHASE);
	fd.append('processingMode', 'full');
	fd.append('projectId', PROJECT);

	console.log(`POST ${BASE}/api/cv/capture-ingest`);
	console.log(`  qrCode=${QR}  phase=${PHASE}  projectId=${PROJECT}`);
	console.log(`  key length=${KEY.length}  key starts with letter=${/^[A-Za-z]/.test(KEY)}`);

	const res = await fetch(`${BASE}/api/cv/capture-ingest`, {
		method: 'POST',
		headers: { 'x-agent-api-key': KEY },
		body: fd
	});
	const text = await res.text();
	console.log(`HTTP ${res.status}`);
	console.log(text);
}

main().catch((err) => { console.error(err); process.exit(1); });
