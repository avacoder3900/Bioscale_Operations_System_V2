/**
 * Robot-arm webhook receiver.
 *
 * The Pi-side BimsClient (see avacoder3900/robot-arm src/server/bims_client.py)
 * POSTs one event per state change to this endpoint with shape:
 *   { run_id: string, event: { type, at, run_id, ... } }
 * authenticated via `x-agent-api-key: $AGENT_API_KEY`.
 *
 * We upsert a RobotArmRun document keyed on run_id and append the event to
 * its events array. The first event the Pi sends for a run is typically
 * `run.started` carrying type/parameters; later events bring status changes
 * and (for record/replay) the final dataset path.
 */
import { json } from '@sveltejs/kit';
import { connectDB, RobotArmRun } from '$lib/server/db';
import { requireAgentApiKey } from '$lib/server/api-auth';
import type { RequestHandler } from './$types';

interface InboundEvent {
	type?: string;
	at?: string;
	run_id?: string;
	[key: string]: unknown;
}

export const POST: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await connectDB();

	const body = await request.json();
	const runId = body?.run_id;
	const event: InboundEvent | undefined = body?.event;

	if (typeof runId !== 'string' || !event) {
		return json({ error: 'Missing run_id or event' }, { status: 400 });
	}

	const at = event.at ? new Date(event.at) : new Date();
	const eventDoc = {
		at,
		type: event.type ?? 'unknown',
		payload: event
	};

	const update: Record<string, unknown> = {
		$push: { events: eventDoc },
		$set: { lastEventAt: at },
		$setOnInsert: { _id: runId, firstSeenAt: at }
	};

	if (event.type === 'run.started') {
		(update.$set as Record<string, unknown>).startedAt = at;
		(update.$set as Record<string, unknown>).status = 'running';
		if (typeof event.task_name === 'string') {
			(update.$set as Record<string, unknown>).parameters = {
				...(typeof event.parameters === 'object' ? event.parameters : {}),
				task_name: event.task_name
			};
		}
		if (typeof event.triggered_by === 'object' && event.triggered_by !== null) {
			(update.$set as Record<string, unknown>).triggeredBy = event.triggered_by;
		}
		if (typeof event.lot_id === 'string') {
			(update.$set as Record<string, unknown>).lotId = event.lot_id;
		}
	}

	if (event.type === 'run.completed') {
		(update.$set as Record<string, unknown>).status = 'completed';
		(update.$set as Record<string, unknown>).endedAt = at;
		if (event.result !== undefined) {
			(update.$set as Record<string, unknown>).result = event.result;
		}
	}

	if (event.type === 'run.failed') {
		(update.$set as Record<string, unknown>).status = 'failed';
		(update.$set as Record<string, unknown>).endedAt = at;
		(update.$set as Record<string, unknown>).result = {
			error: typeof event.error === 'string' ? event.error : String(event.error ?? 'unknown')
		};
	}

	if (event.type === 'run.cancelled') {
		(update.$set as Record<string, unknown>).status = 'cancelled';
		(update.$set as Record<string, unknown>).endedAt = at;
	}

	await RobotArmRun.updateOne({ _id: runId }, update, { upsert: true });

	return json({ ok: true, run_id: runId });
};
