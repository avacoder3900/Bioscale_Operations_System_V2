// Robot-arm webhook receiver.
//
// Robot-arm (Pi) POSTs every run event here as it fires, with body
// `{ run_id, event }` and header `x-agent-api-key` matching AGENT_API_KEY.
// We upsert a RobotArmRun by its runId and append the event. Terminal
// events flip status and stamp finalizedAt (sacred middleware then blocks
// further mutations).
//
// Robot-arm uses status vocabulary {running, success, failed}. We map
// success -> completed for cleaner BIMS semantics. Everything else is
// passed through as-is.

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { connectDB } from '$lib/server/db/connection';
import { RobotArmRun } from '$lib/server/db/models';
import { requireAgentApiKey } from '$lib/server/api-auth';

interface IncomingEvent {
	type: string;
	at?: string;
	[k: string]: unknown;
}

interface IncomingPayload {
	run_id?: string;
	event?: IncomingEvent;
}

const TERMINAL_TYPES = new Set([
	'task.complete',
	'task.failed',
	'task.cancelled',
	'teleop.stop',
	'record.stop',
	'replay.stop',
	'calibrate.complete',
	'calibrate.failed'
]);

function mapStatus(rawStatus: string | undefined, eventType: string): string | null {
	if (rawStatus === 'success') return 'completed';
	if (rawStatus === 'failed') return 'failed';
	if (rawStatus === 'cancelled') return 'cancelled';
	if (rawStatus === 'running') return 'running';
	if (rawStatus === 'pending') return 'pending';
	// No explicit status — infer from event type.
	if (TERMINAL_TYPES.has(eventType)) return 'completed';
	return null;
}

function inferType(eventType: string): string | undefined {
	if (eventType.startsWith('teleop.')) return 'teleop';
	if (eventType.startsWith('record.')) return 'record';
	if (eventType.startsWith('replay.')) return 'replay';
	if (eventType.startsWith('calibrate.')) return 'calibrate';
	if (eventType.startsWith('task.')) return 'task';
	return undefined;
}

export const POST: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);

	const payload = (await request.json().catch(() => null)) as IncomingPayload | null;
	if (!payload?.run_id || !payload?.event?.type) {
		return json({ error: 'run_id and event.type required' }, { status: 400 });
	}

	const { run_id: runId, event } = payload;
	const eventAt = event.at ? new Date(String(event.at)) : new Date();
	const eventType = event.type;

	await connectDB();

	let run = await RobotArmRun.findOne({ runId });

	if (!run) {
		const inferredType = inferType(eventType);
		if (!inferredType) {
			return json(
				{
					error: `cannot infer run type from event "${eventType}" — first event must be a known type prefix (teleop|record|replay|calibrate|task)`
				},
				{ status: 400 }
			);
		}
		// Stamp provenance from the first event's extras. The Pi emits these
		// on the {kind}.start event; legacy events without them simply leave
		// the fields unset.
		run = await RobotArmRun.create({
			runId,
			type: inferredType,
			status: 'running',
			startedAt: eventAt,
			triggeredBy: (event.triggered_by as { _id: string; username: string }) ?? undefined,
			lotId: (event.lot_id as string | undefined) ?? undefined,
			manufacturingStep: (event.manufacturing_step as string | undefined) ?? undefined,
			recordedDuringRunId: (event.recorded_during_run_id as string | undefined) ?? undefined,
			parameters: event.parameters ?? undefined,
			events: [{ at: eventAt, type: eventType, payload: event }]
		});
		return json({ ok: true, runId: run.runId, created: true });
	}

	if (run.finalizedAt) {
		// Sacred middleware would throw — return a clear 409 instead.
		return json({ error: 'run is finalized; cannot append events' }, { status: 409 });
	}

	const newStatus = mapStatus(event.status as string | undefined, eventType);
	const isTerminal = TERMINAL_TYPES.has(eventType);

	const update: Record<string, unknown> = {
		$push: { events: { at: eventAt, type: eventType, payload: event } }
	};
	const set: Record<string, unknown> = {};
	if (newStatus) set.status = newStatus;
	if (isTerminal) {
		set.endedAt = eventAt;
		set.finalizedAt = eventAt;
		if (event.result) set.result = event.result;
	}
	if (Object.keys(set).length > 0) update.$set = set;

	await RobotArmRun.findOneAndUpdate({ runId }, update);

	return json({ ok: true, runId, finalized: isTerminal });
};
