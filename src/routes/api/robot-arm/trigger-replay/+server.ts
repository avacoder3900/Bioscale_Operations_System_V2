/**
 * Trigger an arm replay tied to a manufacturing parent run.
 *
 * POST /api/robot-arm/trigger-replay
 * Body: {
 *   source: string,                        // recording name or absolute Pi path
 *   parent: { type: 'wax'|'reagent'|'spu'|'generic', runId?: string },
 *   enforcePreflight?: boolean,            // default true
 *   tolerance_steps?: number,              // forwarded to preflight (default 50)
 *   loops?: number,                        // default 1
 *   manufacturingStep?: string             // free-form tag (e.g. "arm_transfer")
 * }
 *
 * Behavior:
 *   1. Validates the parent run exists (when runId is provided).
 *   2. POSTs /replay/start to the Pi with preflight enforcement on by default.
 *     Pi returns 409 + {preflight_failed, issues, deltas} on failure — we
 *     bubble it up as 409 so the caller can show the operator exactly which
 *     joint to nudge.
 *   3. On success, stamps the resulting RobotArmRun.runId onto the parent
 *     run (wax: WaxFillingRun.armRunId; reagent: ReagentBatchRecord.armRunId
 *     when that field exists; spu: ignored for now; generic: no stamping).
 *     Stamping is best-effort — the arm replay already fired.
 *
 * Auth: requires the operator session (locals.user). Not an agent endpoint;
 * agents trigger replays via the Pi directly with their own AGENT_API_KEY.
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { connectDB } from '$lib/server/db/connection';
import { WaxFillingRun } from '$lib/server/db/models';
import { robotArm } from '$lib/server/robot-arm-client';
import { requirePermission } from '$lib/server/permissions';

interface TriggerBody {
	source?: string;
	parent?: { type?: string; runId?: string };
	enforcePreflight?: boolean;
	tolerance_steps?: number;
	loops?: number;
	manufacturingStep?: string;
}

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	requirePermission(locals.user, 'manufacturing:write');

	const body = (await request.json().catch(() => null)) as TriggerBody | null;
	if (!body?.source) return json({ error: 'source is required' }, { status: 400 });

	const parentType = body.parent?.type ?? 'generic';
	const parentRunId = body.parent?.runId;
	const enforcePreflight = body.enforcePreflight ?? true;
	const loops = body.loops ?? 1;
	const manufacturingStep = body.manufacturingStep;

	await connectDB();

	// Validate parent exists when caller specified one.
	let lotId: string | undefined;
	if (parentType === 'wax' && parentRunId) {
		const wax = await WaxFillingRun.findById(parentRunId).select('_id activeLotId').lean() as
			| { _id: string; activeLotId?: string }
			| null;
		if (!wax) return json({ error: `wax run ${parentRunId} not found` }, { status: 404 });
		lotId = wax.activeLotId ?? undefined;
	}
	// reagent/spu/generic intentionally skipped — schema fields aren't there yet.
	// Add when the wax pilot proves the wiring works.

	// Fire on the Pi with preflight + provenance stamped.
	let started: { run_id: string; kind: string };
	try {
		started = await robotArm.startReplay({
			source: body.source,
			loops,
			triggered_by: { _id: locals.user._id, username: locals.user.username },
			lot_id: lotId,
			manufacturing_step: manufacturingStep,
			recorded_during_run_id: parentRunId,
			enforce_preflight: enforcePreflight,
			preflight_tolerance_steps: body.tolerance_steps
		});
	} catch (err) {
		const msg = (err as Error).message;
		// Pi returns preflight failures as 409 with a JSON detail; surface it through
		const status = msg.includes('robot-arm 409') ? 409 : 502;
		return json({ error: msg }, { status });
	}

	// Best-effort: stamp armRunId onto the parent so it's queryable by arm activity.
	// The arm replay is already running — a stamp failure here just means cross-ref
	// won't work, not that the operation rolls back.
	if (parentType === 'wax' && parentRunId) {
		try {
			await WaxFillingRun.findByIdAndUpdate(parentRunId, { $set: { armRunId: started.run_id } });
		} catch (err) {
			console.error('[trigger-replay] failed to stamp armRunId on wax run:', err);
		}
	}

	return json({ ok: true, run_id: started.run_id, kind: started.kind, lotId });
};
