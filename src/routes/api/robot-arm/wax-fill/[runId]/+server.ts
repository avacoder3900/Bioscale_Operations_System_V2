/**
 * Agent-facing status endpoint for an ARM-WAX-01 run.
 *
 * GET  → full run state (phase, deck token owner, cross-refs). The Pi
 *        orchestrator / agents poll this to know whether their machine is
 *        authorized to move.
 * POST → report a failure from either machine: { source: 'arm'|'ot2',
 *        error: string }. Flips the run to failed and stamps the error;
 *        idempotent if the run is already terminal.
 *
 * Auth: x-agent-api-key (same key the arm webhook + opentrons agents use).
 */
import { json } from '@sveltejs/kit';
import { connectDB, ArmWaxFillRun, AuditLog, generateId } from '$lib/server/db';
import { DECK_TOKEN } from '$lib/server/arm-wax-fill';
import type { RequestHandler } from './$types';

function authorized(request: Request): boolean {
	const key = request.headers.get('x-api-key') || request.headers.get('x-agent-api-key');
	return !!process.env.AGENT_API_KEY && key === process.env.AGENT_API_KEY;
}

const TERMINAL = ['complete', 'failed', 'aborted'];

export const GET: RequestHandler = async ({ request, params }) => {
	if (!authorized(request)) return json({ error: 'Unauthorized' }, { status: 401 });
	await connectDB();

	const run = await ArmWaxFillRun.findById(params.runId).lean();
	if (!run) return json({ error: 'not found' }, { status: 404 });

	const phase = (run as any).phase as keyof typeof DECK_TOKEN;
	return json({
		run: JSON.parse(JSON.stringify(run)),
		deckToken: DECK_TOKEN[phase] ?? 'none',
		armMayMove: DECK_TOKEN[phase] === 'arm',
		ot2MayMove: DECK_TOKEN[phase] === 'ot2',
		terminal: TERMINAL.includes(phase)
	});
};

export const POST: RequestHandler = async ({ request, params }) => {
	if (!authorized(request)) return json({ error: 'Unauthorized' }, { status: 401 });
	await connectDB();

	let body: { source?: string; error?: string };
	try {
		body = await request.json();
	} catch {
		return json({ error: 'invalid JSON' }, { status: 400 });
	}
	const source = body.source === 'ot2' ? 'ot2' : 'arm';
	const message = (body.error ?? 'agent-reported failure').slice(0, 500);

	const run = await ArmWaxFillRun.findById(params.runId);
	if (!run) return json({ error: 'not found' }, { status: 404 });
	if (TERMINAL.includes(run.phase)) {
		return json({ ok: true, phase: run.phase, note: 'already terminal' });
	}

	const now = new Date();
	run.phase = 'failed';
	run.error = `[${source}] ${message}`;
	run.endedAt = now;
	run.events.push({ at: now, type: `${source}.agent_fail`, phase: 'failed', by: source });
	await run.save();

	await AuditLog.create({
		_id: generateId(),
		tableName: 'arm_wax_fill_runs',
		recordId: run._id,
		action: 'arm_wax_agent_fail',
		newData: { source, error: message },
		changedAt: now,
		changedBy: `agent:${source}`
	});

	return json({ ok: true, phase: run.phase });
};
