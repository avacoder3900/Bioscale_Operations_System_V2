/**
 * OT-2 bridge daemon → BIMS completion of a /bridge DIRECT job
 * (OT2-TAILNET-5 §7.3, S5/S6).
 *
 * The tailnet-line sibling of /api/agent/ot2/commands/<id>/result. On the queue
 * line the Ot2BridgeCommand row IS the durable record of what the daemon did;
 * a direct job has no command row, so its report lands as one AuditLog row
 * (tableName 'ot2_bridge_jobs', recordId <jobId>, action 'bridge_job_result').
 * That is what lets a page reattach after the browser closed or the tailnet
 * dropped mid-job (§7.5): the job kept running on the robot, and its outcome is
 * here.
 *
 * For a sweep it also closes the OpentronsScannerSweepRun if the daemon's final
 * progress post never landed (the same safety net the queue line gets from the
 * command going terminal).
 *
 * Request:  POST /api/agent/ot2/jobs/<jobId>/result   (x-agent-api-key)
 *   { ok: boolean, status?: number, body?: unknown, error?: string, deviceId?, kind? }
 * Response: { success: true } · { success: true, duplicate: true } on a retry.
 */
import { json, error } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB, OpentronsScannerSweepRun, AuditLog, generateId } from '$lib/server/db';
import { BRIDGE_JOB_KINDS } from '../../sweep-progress';
import type { RequestHandler } from './$types';

const MAX_BODY_CHARS = 20_000;

export const POST: RequestHandler = async ({ request, params }) => {
	requireAgentApiKey(request);

	let body: any;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Invalid JSON body');
	}

	const kind = typeof body?.kind === 'string' ? body.kind : '';
	if (!(BRIDGE_JOB_KINDS as readonly string[]).includes(kind)) {
		throw error(400, `kind must be one of ${BRIDGE_JOB_KINDS.join(', ')}`);
	}
	const deviceId = typeof body?.deviceId === 'string' ? body.deviceId.slice(0, 100) : null;
	const ok = !!body?.ok;
	const jobId = params.jobId;

	await connectDB();

	// The daemon retries on 5xx/network; a second delivery must not double-record.
	const existing = await AuditLog.findOne({ tableName: 'ot2_bridge_jobs', recordId: jobId, action: 'bridge_job_result' })
		.select('_id')
		.lean();
	if (existing) return json({ success: true, duplicate: true });

	const now = new Date();
	const errorText = typeof body?.error === 'string' ? body.error.slice(0, 2000) : ok ? null : 'Bridge daemon reported failure';
	let resultBody: unknown = body?.body ?? null;
	try {
		if (JSON.stringify(resultBody).length > MAX_BODY_CHARS) resultBody = { truncated: true };
	} catch {
		resultBody = { unserializable: true };
	}

	let sweepRunId: string | null = null;
	if (kind === 'sweep') {
		const run = (await OpentronsScannerSweepRun.findOne({ bridgeJobId: jobId }).select('_id status').lean()) as any;
		sweepRunId = run?._id ?? null;
		if (run && (run.status === 'running' || run.status === 'paused')) {
			const reported = (resultBody as any)?.status;
			const finalStatus = !ok ? 'errored' : ['completed', 'cancelled', 'errored'].includes(reported) ? reported : 'completed';
			await OpentronsScannerSweepRun.updateOne(
				{ _id: run._id, status: { $in: ['running', 'paused'] } },
				{
					$set: {
						status: finalStatus,
						completedAt: now,
						...(errorText ? { abortReason: errorText.slice(0, 500) } : {})
					},
					$push: {
						log: {
							ts: now,
							level: finalStatus === 'completed' ? 'info' : 'warn',
							message: `Sweep closed from the bridge job result (${finalStatus}) — the final progress update never arrived.`
						}
					}
				}
			);
		}
	}

	await AuditLog.create({
		_id: generateId(),
		tableName: 'ot2_bridge_jobs',
		recordId: jobId,
		action: 'bridge_job_result',
		newData: {
			jobId,
			kind,
			deviceId,
			line: 'tailnet',
			ok,
			status: ok ? Number(body?.status ?? 200) : null,
			error: errorText,
			body: resultBody,
			...(sweepRunId ? { sweepRunId } : {})
		},
		changedAt: now,
		changedBy: deviceId ?? 'ot2-bridge'
	});

	return json({ success: true });
};
