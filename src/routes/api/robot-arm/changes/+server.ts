/**
 * The Pi's way into the robot arm Change Log (2026-11-06).
 *
 *   POST /api/robot-arm/changes   header x-agent-api-key (the webhook's key)
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
import { requireAgentApiKey } from '$lib/server/api-auth';
import { logArmChange } from '$lib/server/robot-arm-change-log';
import { parseChangesBody } from './body';

export const POST: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
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
