/**
 * The arm Pi's loop driver calls the loop's steps here (2026-11-06, OPTIONAL).
 *
 *   POST /api/robot-arm/wax-fill/drive   header x-api-key = ROBOT_ARM_API_KEY (the Pi's key)
 *        { loopId, action, step?, error?, runId? }  →  the same JSON the Run tab's action returns
 *
 * Only for a loop whose driver is 'arm-pi' (Setup "Arm Pi Drives The Loop");
 * see $lib/server/arm-loop-drive. Errors answer { error } with the step's status.
 *
 * 2026-11-10: each step writes a "received" and an "answered" row to the
 * Movement Log, keyed by the Pi's x-drive-req header, and the answer echoes
 * x-drive-req and x-drive-ms ($lib/robot-arm/drive-log).
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ArmWaxFillError } from '$lib/server/arm-wax-fill';
import { isArmPiKey, runDriveStep } from '$lib/server/arm-loop-drive';
import { logDriveAnswered, logDriveReceived } from '$lib/server/arm-drive-log';

// The wait steps hold up to ~85 s (the Run tab's actions have the same budget).
export const config = { maxDuration: 120 };

export const POST: RequestHandler = async ({ request }) => {
	if (!isArmPiKey(request)) return json({ error: 'Unauthorized' }, { status: 401 });
	const receivedAt = new Date();
	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	const loopId = typeof body?.loopId === 'string' ? body.loopId : '';
	const action = typeof body?.action === 'string' ? body.action : '';
	if (!loopId || !action) return json({ error: 'loopId and action are required.' }, { status: 400 });

	const reqId = (request.headers.get('x-drive-req') ?? '').slice(0, 64) || null;
	const attempt = Number(request.headers.get('x-drive-attempt')) || null;
	const info = { loopId, action, reqId, attempt, receivedAt, vercelId: request.headers.get('x-vercel-id') };
	// The Pi's log upload is not a loop step: no rows for it.
	const logged = action !== 'driveLog';
	const robot = logged ? logDriveReceived(info) : null;

	let payload: unknown;
	let status = 200;
	let error: string | null = null;
	try {
		payload = await runDriveStep(loopId, action, body ?? {});
	} catch (err) {
		if (err instanceof ArmWaxFillError) {
			status = err.status;
			error = err.message;
		} else {
			console.error('[arm-loop-drive]', err);
			status = 500;
			error = err instanceof Error ? err.message : 'Unexpected error.';
		}
		payload = { error };
	}
	if (robot) await logDriveAnswered(info, { status, error, robot: await robot });
	const headers: Record<string, string> = { 'x-drive-ms': String(Date.now() - receivedAt.getTime()) };
	if (reqId) headers['x-drive-req'] = reqId;
	return json(payload, { status, headers });
};
