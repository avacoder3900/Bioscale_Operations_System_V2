/**
 * Daily integrity scan — runs every check in `src/lib/server/integrity-scan.ts`
 * and upserts findings into the `bims_anomalies` collection. Registered in
 * vercel.json at 07:00 UTC (02:00 Houston local) so findings are ready before
 * the workday starts.
 *
 * Auth follows the same pattern as the other cron endpoints — a CRON_SECRET
 * Bearer header, a vercel-cron user-agent on GET, or the agent API key.
 */
import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB, generateId } from '$lib/server/db';
import { scanAndPersist } from '$lib/server/integrity-scan';
import type { RequestHandler } from './$types';

function authenticate(request: Request): void {
	const authHeader = request.headers.get('authorization')?.replace('Bearer ', '');
	if (env.CRON_SECRET && authHeader === env.CRON_SECRET) return;

	if (request.method === 'GET') {
		const ua = request.headers.get('user-agent') ?? '';
		if (ua.startsWith('vercel-cron/')) return;
	}

	requireAgentApiKey(request);
}

async function runScan(request: Request) {
	authenticate(request);
	await connectDB();

	const scanRunId = generateId();
	const startedAt = Date.now();
	const summary = await scanAndPersist(scanRunId);
	const durationMs = Date.now() - startedAt;

	return json({
		ok: true,
		scanRunId,
		durationMs,
		totalIssueCount: summary.totalIssueCount,
		issues: summary.issues,
		byKindCounts: Object.fromEntries(
			Object.entries(summary.byKind).map(([k, v]) => [k, v.count])
		)
	});
}

export const GET: RequestHandler = async ({ request }) => runScan(request);
export const POST: RequestHandler = async ({ request }) => runScan(request);
