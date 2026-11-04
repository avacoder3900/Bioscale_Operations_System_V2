import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { purgeExpiredArchive } from '$lib/server/robot-arm-archive-purge';
import type { RequestHandler } from './$types';

// Daily: Robot Arm items archived (or superseded) more than 30 days ago are
// copied to R2, the copy is verified, then they are deleted. See
// $lib/server/robot-arm-archive-purge for what is covered and what is kept.

function authenticate(request: Request): void {
	// CRON_SECRET Bearer (Vercel sends it automatically when the env var is set)
	// or the agent API key. No user-agent fallback — that header is forgeable.
	const auth = request.headers.get('authorization')?.replace('Bearer ', '');
	if (env.CRON_SECRET && auth === env.CRON_SECRET) return;
	requireAgentApiKey(request);
}

async function run(request: Request) {
	authenticate(request);
	const report = await purgeExpiredArchive();
	const purged = Object.values(report.purged).reduce((n, a) => n + a.length, 0);
	console.log(`[ARM ARCHIVE PURGE] purged=${purged} failed=${report.failed.length}`);
	return json({ success: report.failed.length === 0, purgedCount: purged, ...report });
}

export const GET: RequestHandler = ({ request }) => run(request);
export const POST: RequestHandler = ({ request }) => run(request);
