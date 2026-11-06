/**
 * The robot arm Movement Log for agents (2026-11-06).
 *
 *   GET /api/robot-arm/moves?minutes=60&servo=2&device=ot2&group=ot2:liquid&kind=aspirate&limit=500   header x-api-key = agent key
 *     → { moves: [...newest first], total, summary: [{ servo, moves, reversals }],
 *         timing: [{ device, kind, count, totalS, avgS, maxS }] }
 *
 * device: 'arm' or 'ot2' (the OT-2's commands, 2026-11-06); both when left out.
 * group: a type group from $lib/robot-arm/move-types; kind: one exact type.
 * total: how many rows match, past the limit.
 *
 * Same rows and per-servo summary as Maintenance → Movement Log, so "it kept
 * going back and forth in the last hour" can be checked without the page.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { isAgentApiKey } from '$lib/server/api-auth';
import { countArmMoves, listArmMoves } from '$lib/server/robot-arm-move-log';
import { summarizeServoMoves } from '$lib/robot-arm/move-log';
import { summarizeTiming } from '$lib/robot-arm/ot2-move-log';

export const GET: RequestHandler = async ({ request, url }) => {
	if (!isAgentApiKey(request)) return json({ error: 'Unauthorized' }, { status: 401 });
	const minutes = Number(url.searchParams.get('minutes')) || null;
	const servo = Number(url.searchParams.get('servo')) || null;
	const d = url.searchParams.get('device');
	const device: 'arm' | 'ot2' | null = d === 'arm' || d === 'ot2' ? d : null;
	const group = url.searchParams.get('group');
	const kind = url.searchParams.get('kind');
	const limit = Number(url.searchParams.get('limit')) || 500;
	const filter = { sinceMinutes: minutes, servo, device, group, kind };
	const [moves, total] = await Promise.all([listArmMoves({ ...filter, limit }), countArmMoves(filter)]);
	return json({ moves, total, summary: summarizeServoMoves(moves), timing: summarizeTiming(moves) });
};
