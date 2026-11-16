/**
 * Chute barcode scans (2026-11-16).
 *
 *   POST /api/robot-arm/chute-scans   header x-api-key = ROBOT_ARM_API_KEY (the Pi), or the agent key
 *        { host?, scans: [{ at, ok, code, label, error, elapsed_ms, solenoid, pin, run_id, title, id }] }  (≤ 50)
 *        → { written, duplicates, failed }
 *   GET  /api/robot-arm/chute-scans   session → { warning: ChuteScanWarning | null }
 *
 * Posted by services/robot-arm/src/server/barcode.py after a trapdoor fire step
 * with "Scan Barcode After". A failed scan raises the warning on the arm pages
 * (RobotArmConnectionPanel); it never stops a run. Close: POST ./close.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { timingSafeEqual } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { isAgentApiKey } from '$lib/server/api-auth';
import { requirePermission } from '$lib/server/permissions';
import { parseChuteScansBody } from '$lib/robot-arm/chute-scan';
import { chuteScanWarning, recordChuteScans } from '$lib/server/robot-arm-chute-scan';

function armKeyMatches(given: string | null): boolean {
	const expected = env.ROBOT_ARM_API_KEY ?? '';
	if (!given || !expected) return false;
	const a = Buffer.from(given);
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
}

export const POST: RequestHandler = async ({ request }) => {
	if (!armKeyMatches(request.headers.get('x-api-key')) && !isAgentApiKey(request)) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}
	const { host, scans } = parseChuteScansBody(await request.json().catch(() => null));
	if (!scans.length) return json({ error: 'scans must be a non-empty list' }, { status: 400 });
	return json(await recordChuteScans(host, scans));
};

export const GET: RequestHandler = async ({ locals }) => {
	requirePermission(locals.user, 'manufacturing:read');
	try {
		return json({ warning: await chuteScanWarning() });
	} catch (err) {
		return json({ warning: null, error: err instanceof Error ? err.message : String(err) });
	}
};
