#!/usr/bin/env node
/**
 * Mocreo sync worker — long-running poller.
 *
 * Loops forever, POSTing to /api/mocreo/sync on the configured BIMS host
 * every MOCREO_INTERVAL_MS milliseconds (default 30s).
 *
 * Designed to run under pm2 / systemd / launchd on an always-on machine.
 *
 * Required env:
 *   BIMS_BASE_URL   e.g. https://bioscale-operations-system-v2-git-dev-<team>.vercel.app
 *   AGENT_API_KEY   must match AGENT_API_KEY in Vercel env
 *
 * Optional env:
 *   MOCREO_INTERVAL_MS   default 30000 (30s). Minimum 5000.
 *
 * Usage:
 *   node scripts/mocreo/worker.cjs
 *   # or under pm2:
 *   pm2 start scripts/mocreo/worker.cjs --name mocreo-worker
 */

const BASE_URL = process.env.BIMS_BASE_URL;
const API_KEY = process.env.AGENT_API_KEY;
const INTERVAL_MS = Math.max(5000, parseInt(process.env.MOCREO_INTERVAL_MS || '30000', 10));

if (!BASE_URL || !API_KEY) {
	console.error('[mocreo-worker] FATAL: BIMS_BASE_URL and AGENT_API_KEY env vars are required.');
	process.exit(1);
}

const SYNC_URL = BASE_URL.replace(/\/$/, '') + '/api/mocreo/sync';
let running = true;
let consecutiveFailures = 0;

function ts() {
	return new Date().toISOString();
}

async function syncOnce() {
	const start = Date.now();
	try {
		const res = await fetch(SYNC_URL, {
			method: 'POST',
			headers: {
				'x-api-key': API_KEY,
				'Content-Type': 'application/json',
				'User-Agent': 'bims-mocreo-worker/1.0'
			}
		});

		const text = await res.text();
		let body;
		try {
			body = JSON.parse(text);
		} catch {
			body = { raw: text.slice(0, 500) };
		}

		const ms = Date.now() - start;

		if (!res.ok) {
			consecutiveFailures++;
			console.error(`[${ts()}] sync HTTP ${res.status} (${ms}ms) — ${JSON.stringify(body).slice(0, 400)}`);
			return;
		}

		consecutiveFailures = 0;
		const count = body.sensorCount ?? (body.results?.length ?? 0);
		const errors = (body.results ?? []).filter((r) => r.error || (r.alerts ?? []).includes('error'));
		if (errors.length > 0) {
			console.warn(
				`[${ts()}] sync ok (${ms}ms) — ${count} sensors, ${errors.length} with errors: ` +
					errors.map((e) => `${e.sensorId}:${e.error ?? 'error'}`).join('; ').slice(0, 400)
			);
		} else {
			console.log(`[${ts()}] sync ok (${ms}ms) — ${count} sensors`);
		}
	} catch (err) {
		consecutiveFailures++;
		console.error(`[${ts()}] sync network error — ${err.message}`);
	}
}

async function loop() {
	console.log(`[${ts()}] mocreo-worker starting — ${SYNC_URL} every ${INTERVAL_MS}ms`);
	while (running) {
		await syncOnce();

		// Exponential backoff on repeated failures (up to 5 min) so a broken
		// endpoint doesn't hammer the server.
		const backoff =
			consecutiveFailures > 3
				? Math.min(INTERVAL_MS * Math.pow(2, Math.min(consecutiveFailures - 3, 4)), 5 * 60 * 1000)
				: INTERVAL_MS;

		await new Promise((r) => setTimeout(r, backoff));
	}
}

function shutdown(signal) {
	console.log(`[${ts()}] received ${signal}, shutting down.`);
	running = false;
	setTimeout(() => process.exit(0), 1000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

loop().catch((err) => {
	console.error(`[${ts()}] fatal loop error:`, err);
	process.exit(1);
});
