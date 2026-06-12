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
import type { RequestHandler } from './$types';

// split:true gives this dynamic-segment endpoint its own Vercel function instead
// of a symlink into the merged group, working around a Vercel deploy-time bug that
// 404s bracketed API routes at the edge before they reach our code.
export const config = { split: true };

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

	const now = new Date();
	const set: Record<string, unknown> = {};
	const push: Record<string, unknown> = {};

	if (typeof body?.slotsDone === 'number') set.slotsDone = body.slotsDone;
	if (typeof body?.currentSlotIndex === 'number') set.currentSlotIndex = body.currentSlotIndex;
	if (body?.scan && typeof body.scan.slotIndex === 'number') {
		push.scans = {
			slotIndex: body.scan.slotIndex,
			barcode: String(body.scan.barcode ?? ''),
			rawPayload: body.scan.rawPayload ?? null,
			scannedAt: now,
			x: body.scan.x, y: body.scan.y, z: body.scan.z,
			attempts: body.scan.attempts ?? 1
		};
	}
	if (body?.slotError && typeof body.slotError.slotIndex === 'number') {
		push.errors = {
			slotIndex: body.slotError.slotIndex,
			message: String(body.slotError.message ?? 'scan failed').slice(0, 500),
			recordedAt: now,
			attempts: body.slotError.attempts ?? 1
		};
	}
	if (Array.isArray(body?.log) && body.log.length > 0) {
		push.log = {
			$each: body.log.slice(0, 20).map((l: any) => ({
				ts: now,
				level: ['info', 'warn', 'error'].includes(l?.level) ? l.level : 'info',
				message: String(l?.message ?? '').slice(0, 500),
				slotIndex: typeof l?.slotIndex === 'number' ? l.slotIndex : undefined
			}))
		};
	}

	// Terminal update: the daemon finished (or aborted) the sweep — close out
	// the SweepRun so the UI's poll sees a terminal status.
	if (body?.final && ['completed', 'errored', 'cancelled'].includes(body.final.status)) {
		set.status = body.final.status;
		set.completedAt = now;
		if (body.final.abortReason) set.abortReason = String(body.final.abortReason).slice(0, 500);
	}

	const update: Record<string, unknown> = {};
	if (Object.keys(set).length) update.$set = set;
	if (Object.keys(push).length) update.$push = push;

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
