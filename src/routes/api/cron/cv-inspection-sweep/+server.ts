/**
 * /api/cron/cv-inspection-sweep — fail CV inspections stuck in 'running'.
 *
 * A hung or dead cv-worker leaves CvInspection docs in status 'running'
 * forever (PRD CV-VERDICT-CALIBRATION-AND-GATING §8.3). This sweep marks any
 * inspection still 'running' more than 10 minutes after it was triggered as
 * 'failed' with a timeout message, so the gate's 'pending' state can never
 * deadlock a cartridge.
 *
 * Runs via Vercel Cron every 10 minutes (see vercel.json). Manual trigger via
 * GET/POST. Auth mirrors the other cron routes: CRON_SECRET bearer token
 * (Vercel cron) or the agent API key.
 */
import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB } from '$lib/server/db/connection.js';
import { CvInspection } from '$lib/server/db/models/cv-inspection.js';
import { AuditLog } from '$lib/server/db/models/audit-log.js';
import { generateId } from '$lib/server/db/utils.js';
import type { RequestHandler } from './$types';

const STALE_AFTER_MS = 10 * 60 * 1000;
const SWEEPER = '<cv-inspection-sweep>';

function authenticate(request: Request): void {
	const auth = request.headers.get('authorization')?.replace('Bearer ', '');
	if (env.CRON_SECRET && auth === env.CRON_SECRET) return;
	requireAgentApiKey(request);
}

async function runSweep(request: Request) {
	authenticate(request);
	await connectDB();

	const now = new Date();
	const cutoff = new Date(now.getTime() - STALE_AFTER_MS);

	// Grab the ids first so the audit entry can name the swept inspections.
	const stale = (await CvInspection.find({ status: 'running', triggeredAt: { $lt: cutoff } })
		.select('_id')
		.lean()) as Array<{ _id: string }>;
	const staleIds = stale.map((d) => d._id);

	let swept = 0;
	if (staleIds.length > 0) {
		// Re-assert status:'running' in the update filter so an inspection that
		// completed between the find and the update is left untouched.
		const res = await CvInspection.updateMany(
			{ _id: { $in: staleIds }, status: 'running' },
			{
				$set: {
					status: 'failed',
					errorMessage: 'timed out waiting for cv-worker',
					completedAt: now
				}
			}
		);
		swept = res.modifiedCount ?? 0;

		if (swept > 0) {
			await AuditLog.create({
				_id: generateId(),
				tableName: 'cv_inspections',
				recordId: staleIds.join(','),
				action: 'UPDATE',
				oldData: { status: 'running' },
				newData: {
					status: 'failed',
					errorMessage: 'timed out waiting for cv-worker',
					inspectionIds: staleIds
				},
				changedFields: ['status', 'errorMessage', 'completedAt'],
				changedAt: now,
				changedBy: SWEEPER,
				reason: `stale-inspection sweep: ${swept} inspection(s) running > 10 min`
			});
		}
	}

	return json({ success: true, scanned: staleIds.length, swept, cutoff: cutoff.toISOString() });
}

export const GET: RequestHandler = ({ request }) => runSweep(request);
export const POST: RequestHandler = ({ request }) => runSweep(request);
