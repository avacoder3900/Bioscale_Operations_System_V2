/**
 * Daily device monitor review — Claude reads one day of telemetry for every
 * SPU with monitoring.enabled and writes a verdict + findings to
 * device_findings. Registered in vercel.json at 07:30 UTC (after the firmware
 * logs from the previous day's tests have landed; before the workday).
 *
 * Query params: spuId=<id> (one unit), hours=<n> (window, default 24),
 * model=<id>, dry=1 (build the prompt, call nothing, return it).
 * Auth: CRON_SECRET Bearer or the agent API key, like the other crons.
 */
import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { runDailyReview } from '$lib/server/device-monitor-review';
import type { RequestHandler } from './$types';

export const config = { maxDuration: 300 };

function authenticate(request: Request): void {
	const authHeader = request.headers.get('authorization')?.replace('Bearer ', '');
	if (env.CRON_SECRET && authHeader === env.CRON_SECRET) return;
	requireAgentApiKey(request);
}

async function run(request: Request, url: URL) {
	authenticate(request);
	const startedAt = Date.now();
	const spuId = url.searchParams.get('spuId') ?? undefined;
	const hours = Number(url.searchParams.get('hours') ?? 24) || 24;
	const model = url.searchParams.get('model') ?? undefined;
	const dryRun = url.searchParams.get('dry') === '1';
	const { results, monitored } = await runDailyReview({ spuId, hours, model, dryRun });
	return json({
		ok: true,
		monitored,
		reviewed: results.length,
		durationMs: Date.now() - startedAt,
		results: results.map((r) => (dryRun ? r : { ...r, prompt: undefined }))
	});
}

export const GET: RequestHandler = async ({ request, url }) => run(request, url);
export const POST: RequestHandler = async ({ request, url }) => run(request, url);
