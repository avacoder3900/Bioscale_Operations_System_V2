/**
 * OT-2 bridge daemon → BIMS calibrator limit-switch trip.
 *
 * Request:
 *   POST /api/agent/ot2/commands/<id>/switch-event
 *   {
 *     axis: 'x' | 'y',
 *     trippedAt?: ISO string,        // daemon's clock at the moment of the trip
 *     position?: { x, y, z },        // pipette position read at the trip
 *     bend?: { x, y },               // the fixture's serial 'bend' baseline
 *     note?: string
 *   }
 *   … or { heartbeat: true } — records nothing, just asks "am I still wanted?".
 *
 * Response: { success, cancelRequested, eventCount }
 *
 * One POST per trip, appended to the command's events[]. `cancelRequested` is
 * echoed so the daemon can drop the watch the moment the operator presses Stop
 * (which flips the command terminal) without needing a second channel — the
 * same handshake /progress uses for sweeps.
 *
 * The heartbeat exists because trips are the ONLY other traffic on this channel,
 * and an operator who presses Stop without ever touching a switch generates
 * none. Without it the daemon would hold the calibrator's serial port until its
 * own deadline — locking the fixture against the next operation for minutes
 * after the watch was visibly stopped.
 *
 * A sibling of /progress rather than a change to it: that endpoint is hard-wired
 * to sweepRunId and mirrors onto OpentronsScannerSweepRun, and generalising it
 * underneath the live sweep UI to carry a different routine's events would put
 * the deck-loading page at risk for no benefit here.
 */
import { json, error } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB, Ot2BridgeCommand } from '$lib/server/db';
import type { RequestHandler } from './$types';

/**
 * Hard ceiling on trips per watch.
 *
 * A limit switch that is stuck closed, or chattering against a tip resting on
 * it, posts continuously — this is an unbounded $push driven by a physical
 * contact, so it needs a bound that does not depend on the daemon behaving.
 * Well above any real teach (a handful of trips) and far below anything that
 * could bloat the document.
 */
const MAX_EVENTS = 500;

export const POST: RequestHandler = async ({ request, params }) => {
	requireAgentApiKey(request);

	let body: any;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Invalid JSON body');
	}

	const heartbeat = body?.heartbeat === true;
	const axis = typeof body?.axis === 'string' ? body.axis.trim().toLowerCase() : '';
	if (!heartbeat && axis !== 'x' && axis !== 'y') throw error(400, "axis must be 'x' or 'y'");

	await connectDB();

	const cmd = (await Ot2BridgeCommand.findById(params.id).select('status kind events').lean()) as any;
	if (!cmd) throw error(404, 'Unknown command');
	if (cmd.kind !== 'calibrator_watch') throw error(400, 'Command is not a calibrator watch');

	// A heartbeat asks one question and changes nothing. Answered before the
	// event-ceiling check below so a watch that hit its cap still gets a truthful
	// "stand down" rather than an error about an event it did not try to post.
	if (heartbeat) {
		return json({
			success: cmd.status === 'claimed',
			cancelRequested: cmd.status !== 'claimed',
			eventCount: cmd.events?.length ?? 0
		});
	}

	// Terminal already = the operator stopped the watch (or it expired). Tell the
	// daemon to stand down instead of accepting trips into a finished record.
	if (cmd.status !== 'claimed') {
		return json(
			{ success: false, status: cmd.status, cancelRequested: true, eventCount: cmd.events?.length ?? 0 },
			{ status: 409 }
		);
	}

	if ((cmd.events?.length ?? 0) >= MAX_EVENTS) {
		return json(
			{
				success: false,
				cancelRequested: true,
				eventCount: cmd.events.length,
				error: `Watch hit its ${MAX_EVENTS}-trip ceiling — a switch is probably stuck closed`
			},
			{ status: 409 }
		);
	}

	const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : null);
	const trippedAt = body?.trippedAt ? new Date(body.trippedAt) : new Date();

	const event = {
		axis,
		// The daemon's timestamp is preferred — it is the one taken at the trip
		// rather than after a network hop — but a bad clock must not produce an
		// Invalid Date on the record, so fall back to arrival time.
		trippedAt: Number.isNaN(trippedAt.getTime()) ? new Date() : trippedAt,
		receivedAt: new Date(),
		// Nulls, never zeros: a missing position must not read as the deck corner.
		position: body?.position
			? { x: num(body.position.x), y: num(body.position.y), z: num(body.position.z) }
			: null,
		bend: body?.bend ? { x: num(body.bend.x), y: num(body.bend.y) } : null,
		note: typeof body?.note === 'string' ? body.note.slice(0, 500) : null
	};

	const updated = (await Ot2BridgeCommand.findOneAndUpdate(
		{ _id: params.id, status: 'claimed' },
		{ $push: { events: event } },
		{ new: true, projection: { events: 1, status: 1 } }
	).lean()) as any;

	// Lost the race against a Stop between the read above and this write.
	if (!updated) {
		return json({ success: false, cancelRequested: true, eventCount: 0 }, { status: 409 });
	}

	return json({
		success: true,
		cancelRequested: false,
		eventCount: updated.events?.length ?? 0
	});
};
