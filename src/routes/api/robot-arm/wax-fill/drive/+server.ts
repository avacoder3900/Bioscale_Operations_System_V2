/**
 * The arm Pi's loop driver calls the loop's steps here (2026-11-06, OPTIONAL).
 *
 *   POST /api/robot-arm/wax-fill/drive   header x-api-key = ROBOT_ARM_API_KEY (the Pi's key)
 *        { loopId, action, step?, error?, runId? }  →  the same JSON the Run tab's action returns
 *
 * Only for a loop whose driver is 'arm-pi' (Setup "Arm Pi Drives The Loop");
 * see $lib/server/arm-loop-drive. Errors answer { error } with the step's status.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ArmWaxFillError } from '$lib/server/arm-wax-fill';
import { isArmPiKey, runDriveStep } from '$lib/server/arm-loop-drive';

// The wait steps hold up to ~85 s (the Run tab's actions have the same budget).
export const config = { maxDuration: 120 };

export const POST: RequestHandler = async ({ request }) => {
	if (!isArmPiKey(request)) return json({ error: 'Unauthorized' }, { status: 401 });
	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	const loopId = typeof body?.loopId === 'string' ? body.loopId : '';
	const action = typeof body?.action === 'string' ? body.action : '';
	if (!loopId || !action) return json({ error: 'loopId and action are required.' }, { status: 400 });
	try {
		return json(await runDriveStep(loopId, action, body ?? {}));
	} catch (err) {
		if (err instanceof ArmWaxFillError) return json({ error: err.message }, { status: err.status });
		console.error('[arm-loop-drive]', err);
		return json({ error: err instanceof Error ? err.message : 'Unexpected error.' }, { status: 500 });
	}
};
