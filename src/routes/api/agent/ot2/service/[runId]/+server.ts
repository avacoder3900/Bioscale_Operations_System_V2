/**
 * Fill protocol → BIMS in-run service channel (WAX-SERVICE-1).
 *
 * Called by the wax fill protocol running ON the OT-2 (see
 * protocols/Wax_Filling_GEN7_Cartridge.py). The robot already reaches BIMS
 * outbound — that is exactly what scripts/ot2-bridge.py does — so the protocol
 * talks to this endpoint directly rather than through the bridge queue. Going
 * through the bridge would stall it: that daemon is a strict single worker and
 * a parked service session would block the 2s run-status polls.
 *
 * GET  /api/agent/ot2/service/:runId?wait=8000
 *   Cheap "is service wanted?" check, called between wells (throttled
 *   protocol-side). Held open only once a session is already open, so an
 *   operator jog is picked up near-instantly.
 *
 *   → { success, service: false }                        nothing wanted
 *   → { success, service: true, sessionId, command: null }
 *   → { success, service: true, sessionId, command: { id, verb, args } }
 *
 * POST /api/agent/ot2/service/:runId
 *   { event: 'entered', location }   protocol parked in its service loop
 *   { event: 'location', location }  position changed (e.g. after goto_well)
 *   { event: 'result', id, verb, ok, detail }
 *   { event: 'resumed' }             back to dispensing — closes the session
 */
import { json, error } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB, Ot2ServiceSession } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const config = { maxDuration: 30 };

const RECHECK_MS = 250;
const MAX_WAIT_MS = 10_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The live session for a run, if any. */
function liveSessionQuery(runId: string) {
	return { opentronsRunId: runId, status: { $in: ['requested', 'active'] } };
}

function locationFrom(body: any) {
	const loc = body?.location ?? {};
	return {
		wellName: typeof loc.wellName === 'string' ? loc.wellName : undefined,
		lastWellName: typeof loc.lastWellName === 'string' ? loc.lastWellName : undefined,
		volumeUl: Number.isFinite(Number(loc.volumeUl)) ? Number(loc.volumeUl) : undefined,
		tipNumber: Number.isFinite(Number(loc.tipNumber)) ? Number(loc.tipNumber) : undefined,
		adjustX: Number.isFinite(Number(loc.adjustX)) ? Number(loc.adjustX) : undefined,
		adjustY: Number.isFinite(Number(loc.adjustY)) ? Number(loc.adjustY) : undefined,
		reportedAt: new Date()
	};
}

export const GET: RequestHandler = async ({ request, params, url }) => {
	requireAgentApiKey(request);

	const runId = params.runId;
	if (!runId) throw error(400, 'runId is required');
	const waitMs = Math.max(0, Math.min(MAX_WAIT_MS, Number(url.searchParams.get('wait')) || 0));

	await connectDB();

	const deadline = Date.now() + waitMs;
	// eslint-disable-next-line no-constant-condition
	while (true) {
		// Hand out the pending command and mark it delivered in ONE write, so a
		// racing poll can't pick up the same physical move twice.
		const claimed = await Ot2ServiceSession.findOneAndUpdate(
			{ ...liveSessionQuery(runId), 'pendingCommand.id': { $ne: null }, 'pendingCommand.deliveredAt': null },
			{ $set: { 'pendingCommand.deliveredAt': new Date(), updatedAt: new Date() } },
			{ new: true }
		).lean() as any;

		if (claimed) {
			return json({
				success: true,
				service: true,
				sessionId: String(claimed._id),
				command: JSON.parse(JSON.stringify({
					id: claimed.pendingCommand?.id ?? null,
					verb: claimed.pendingCommand?.verb ?? null,
					args: claimed.pendingCommand?.args ?? {}
				}))
			});
		}

		const session = await Ot2ServiceSession.findOne(liveSessionQuery(runId))
			.select('_id status')
			.lean() as any;

		if (!session) return json({ success: true, service: false });

		// A session is open but has no work queued — hold the connection so the
		// next jog lands immediately, then answer with command: null.
		if (Date.now() + RECHECK_MS > deadline) {
			return json({
				success: true,
				service: true,
				sessionId: String(session._id),
				command: null
			});
		}
		await sleep(RECHECK_MS);
	}
};

export const POST: RequestHandler = async ({ request, params }) => {
	requireAgentApiKey(request);

	const runId = params.runId;
	if (!runId) throw error(400, 'runId is required');

	let body: any;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Invalid JSON body');
	}

	const event = typeof body?.event === 'string' ? body.event : '';
	await connectDB();

	const session = await Ot2ServiceSession.findOne(liveSessionQuery(runId)).lean() as any;
	if (!session) {
		// The operator may have aborted while the protocol was mid-verb. Tell the
		// protocol to resume rather than failing it.
		return json({ success: true, service: false });
	}

	const now = new Date();

	if (event === 'entered' || event === 'location') {
		await Ot2ServiceSession.updateOne(
			{ _id: session._id },
			{
				$set: {
					...(event === 'entered' ? { status: 'active' } : {}),
					location: locationFrom(body),
					updatedAt: now
				}
			}
		);
		return json({ success: true, service: true });
	}

	if (event === 'result') {
		const id = typeof body?.id === 'string' ? body.id : '';
		const ok = body?.ok !== false;
		const detail = typeof body?.detail === 'string' ? body.detail.slice(0, 2000) : '';
		const verb = typeof body?.verb === 'string' ? body.verb : (session.pendingCommand?.verb ?? '');

		// Only clear the slot if this result answers the command that is actually
		// outstanding — a late result from an aborted command must not eat a
		// freshly queued one.
		const matches = !id || !session.pendingCommand?.id || session.pendingCommand.id === id;

		await Ot2ServiceSession.updateOne(
			{ _id: session._id },
			{
				$set: {
					lastResult: { id, verb, ok, detail, completedAt: now },
					...(matches ? { pendingCommand: null } : {}),
					...(body?.location ? { location: locationFrom(body) } : {}),
					updatedAt: now
				},
				$push: { history: { verb, args: session.pendingCommand?.args ?? {}, ok, detail, by: 'protocol', at: now } }
			}
		);
		return json({ success: true, service: true });
	}

	if (event === 'resumed') {
		await Ot2ServiceSession.updateOne(
			{ _id: session._id },
			{
				$set: {
					status: 'closed',
					closedReason: 'resumed by operator',
					pendingCommand: null,
					closedAt: now,
					updatedAt: now
				}
			}
		);
		return json({ success: true, service: false });
	}

	throw error(400, `Unknown event '${event}'`);
};
