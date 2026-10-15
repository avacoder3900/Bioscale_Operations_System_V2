/**
 * OT-2 bridge daemon → BIMS sweep progress for a /bridge DIRECT job
 * (OT2-TAILNET-5 §7.3, S5/S6).
 *
 * The tailnet-line sibling of /api/agent/ot2/commands/<id>/progress. A sweep a
 * browser submitted straight to the robot (POST /bridge/jobs) has no
 * Ot2BridgeCommand; its OpentronsScannerSweepRun was created by the
 * /api/scanner/sweep tailnet-prepare half with bridgeJobId = <jobId>. The
 * daemon posts the SAME body it posts for a queue sweep, so the SAME rows are
 * written (sweepProgressUpdate) and the run keeps updating with the browser
 * closed.
 *
 * Request:  POST /api/agent/ot2/jobs/<jobId>/progress   (x-agent-api-key)
 *   { sweepRunId, slotsDone?, currentSlotIndex?, scan?, slotError?, log?, final?,
 *     deviceId?, kind? }
 * Response: { success: true, pauseRequested, cancelRequested }
 *   404 = no sweep run carries this job id · 409 = the run is already terminal
 *   (e.g. cancelled in BIMS) → cancelRequested: true, like a non-claimed command.
 */
import { json, error } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB, OpentronsScannerSweepRun } from '$lib/server/db';
import { sweepProgressUpdate, TERMINAL_SWEEP_STATUSES } from '../../sweep-progress';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, params }) => {
	requireAgentApiKey(request);

	let body: any;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Invalid JSON body');
	}

	const sweepRunId = typeof body?.sweepRunId === 'string' ? body.sweepRunId.trim() : '';
	if (!sweepRunId) throw error(400, 'sweepRunId is required');

	await connectDB();

	// The job must own this sweep run, and the run must still be live — a
	// cancelled/terminal run shouldn't keep being mutated.
	const current = (await OpentronsScannerSweepRun.findOne({ _id: sweepRunId, bridgeJobId: params.jobId })
		.select('status')
		.lean()) as any;
	if (!current) throw error(404, 'Unknown sweep run for this job');
	if (TERMINAL_SWEEP_STATUSES.includes(current.status)) {
		return json(
			{ success: false, status: current.status, pauseRequested: false, cancelRequested: true },
			{ status: 409 }
		);
	}

	const now = new Date();
	const update = sweepProgressUpdate(body, now) as { $set?: Record<string, unknown> };
	// Tailnet-only liveness stamp (the queue line uses the command's status for
	// this); every other field is exactly what the commands route writes.
	update.$set = { ...(update.$set ?? {}), bridgeLastReportAt: now };
	const run = (await OpentronsScannerSweepRun.findByIdAndUpdate(sweepRunId, update, { new: true })
		.select('pauseRequested cancelRequested status')
		.lean()) as any;

	if (!run) throw error(404, 'Unknown sweep run');

	return json({
		success: true,
		pauseRequested: !!run.pauseRequested,
		cancelRequested: !!run.cancelRequested || run.status === 'cancelled'
	});
};
