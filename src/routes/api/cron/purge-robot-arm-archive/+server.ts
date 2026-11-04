import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { purgeExpiredArchive } from '$lib/server/robot-arm-archive';
import type { RequestHandler } from './$types';

// Daily: Robot Arm items archived to the R2 trash more than 30 days ago are
// deleted from R2 for good, and their trash rows marked purged. Archiving
// itself (upload, verify, remove from Mongo) happens when the button is
// pressed — see $lib/server/robot-arm-archive.

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
	console.log(`[ARM ARCHIVE PURGE] purged=${report.purged} failed=${report.failed.length}`);
	return json({ success: report.failed.length === 0, purgedCount: report.purged, failed: report.failed });
}

export const GET: RequestHandler = ({ request }) => run(request);
export const POST: RequestHandler = ({ request }) => run(request);
