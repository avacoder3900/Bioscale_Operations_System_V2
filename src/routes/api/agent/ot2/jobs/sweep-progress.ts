/**
 * The OpentronsScannerSweepRun update for ONE daemon sweep-progress body.
 *
 * This is the exact mapping /api/agent/ot2/commands/[id]/progress applies
 * inline (same fields, same caps, same enum guards), extracted so the
 * tailnet-line sibling /api/agent/ot2/jobs/[jobId]/progress writes the SAME
 * rows. Keep the two in lockstep; the commands route is intentionally not
 * edited in this change (queue line byte-identical) — folding it onto this
 * helper is a follow-up.
 */
export function sweepProgressUpdate(body: any, now: Date): Record<string, unknown> {
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
	return update;
}

/** Job kinds the daemon may report on (DIRECT_JOB_KINDS in ot2-bridge.py). */
export { BRIDGE_JOB_KINDS } from '$lib/opentrons/bridge-client';

export const TERMINAL_SWEEP_STATUSES = ['completed', 'errored', 'cancelled'];
