/**
 * OT-2 bridge daemon → BIMS sweep progress (OT2-BRIDGE-2).
 *
 * The daemon posts one update per slot while executing a kind:'sweep'
 * command. BIMS mirrors the update onto the OpentronsScannerSweepRun doc
 * (which the existing sweep UI polls) and echoes the run's live control
 * flags so the daemon can honor pause/cancel between slots.
 *
 * Request:
 *   POST /api/agent/ot2/commands/<id>/progress
 *   {
 *     sweepRunId: string,
 *     slotsDone?: number, currentSlotIndex?: number,
 *     scan?: { slotIndex, barcode, rawPayload?, x, y, z, attempts },
 *     slotError?: { slotIndex, message, attempts },
 *     log?: [{ level, message, slotIndex? }],
 *     final?: { status: 'completed' | 'errored' | 'cancelled', abortReason? }
 *   }
 *
 * Response: { success: true, pauseRequested: boolean, cancelRequested: boolean }
 */
import { json, error } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB, Ot2BridgeCommand, OpentronsScannerSweepRun } from '$lib/server/db';
import { sweepProgressUpdate } from '../../../jobs/sweep-progress';
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

	// The command must still be live — a cancelled/expired command shouldn't
	// keep mutating the sweep run.
	const cmd = await Ot2BridgeCommand.findById(params.id).select('status').lean() as any;
	if (!cmd) throw error(404, 'Unknown command');
	if (cmd.status !== 'claimed') {
		return json({ success: false, status: cmd.status, pauseRequested: false, cancelRequested: true }, { status: 409 });
	}

	// The update itself is sweepProgressUpdate — the ONE mapping, shared with the
	// tailnet-line sibling /api/agent/ot2/jobs/[jobId]/progress. It is the exact
	// code that used to be inline here (progress.test.ts pins the documents).
	const update = sweepProgressUpdate(body, new Date());

	const run = Object.keys(update).length
		? await OpentronsScannerSweepRun.findByIdAndUpdate(sweepRunId, update, { new: true })
			.select('pauseRequested cancelRequested status').lean() as any
		: await OpentronsScannerSweepRun.findById(sweepRunId)
			.select('pauseRequested cancelRequested status').lean() as any;

	if (!run) throw error(404, 'Unknown sweep run');

	return json({
		success: true,
		pauseRequested: !!run.pauseRequested,
		cancelRequested: !!run.cancelRequested || run.status === 'cancelled'
	});
};
