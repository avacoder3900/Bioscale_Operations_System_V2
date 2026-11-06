/**
 * The Pi's way into the robot arm Change Log (2026-11-06).
 *
 *   POST /api/robot-arm/changes   header x-api-key = ROBOT_ARM_API_KEY (the Pi's own key, as the
 *                                 tunnel route takes it), or the agent key
 *        { host?: string, changes: [{ hardware, key, target?, oldValue?, newValue?, unit?,
 *                                     note?, details?, page?, source?, at? }, ...] }   (≤ 50)
 *        → { written, rejected: [{ index, reason }], failed: [index, ...] }
 *
 * Written by services/robot-arm/src/server/bims_changes.py: gain writes
 * (servo_config.py), router installs (scripts/install_*.py via
 * scripts/bims_report.py), service starts (install_change_reporter.py) and
 * changes typed by hand on the Pi. Labels are the same as every other row
 * ($lib/robot-arm/change-labels); `rejected` rows had a bad label and the Pi
 * drops them, `failed` rows could not be stored and the Pi keeps them pending.
 * changedBy is the Pi's hostname, never a BIMS user.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { timingSafeEqual } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { isAgentApiKey } from '$lib/server/api-auth';
import { logArmChange } from '$lib/server/robot-arm-change-log';
import { parseChangesBody } from './body';

/** The Pi holds ROBOT_ARM_API_KEY (BIMS sends it to the Pi; the tunnel route takes it back), not the agent key. */
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
	const parsed = parseChangesBody(await request.json().catch(() => null));
	const who = { _id: 'arm-pi', username: parsed.host ?? 'arm-pi' };
	let written = 0;
	const failed: number[] = [];
	for (const { index, change } of parsed.changes) {
		const id = await logArmChange(who, change);
		if (id) written++;
		else failed.push(index);
	}
	return json({ written, rejected: parsed.rejected, failed });
};
