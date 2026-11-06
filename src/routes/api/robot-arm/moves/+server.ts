/**
 * The robot arm Movement Log for agents (2026-11-06).
 *
 *   GET /api/robot-arm/moves?minutes=60&servo=2&limit=500   header x-api-key = agent key
 *     → { moves: [...newest first], summary: [{ servo, moves, reversals }] }
 *
 * Same rows and per-servo summary as Maintenance → Movement Log, so "it kept
 * going back and forth in the last hour" can be checked without the page.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { isAgentApiKey } from '$lib/server/api-auth';
import { listArmMoves } from '$lib/server/robot-arm-move-log';
import { summarizeServoMoves } from '$lib/robot-arm/move-log';

export const GET: RequestHandler = async ({ request, url }) => {
	if (!isAgentApiKey(request)) return json({ error: 'Unauthorized' }, { status: 401 });
	const minutes = Number(url.searchParams.get('minutes')) || null;
	const servo = Number(url.searchParams.get('servo')) || null;
	const limit = Number(url.searchParams.get('limit')) || 500;
	const moves = await listArmMoves({ sinceMinutes: minutes, servo, limit });
	return json({ moves, summary: summarizeServoMoves(moves) });
};
