/**
 * One Arrival row's fast trace for the Movement Log's Show Trace (2026-11-11).
 *
 *   GET ?id=<move row id>  → { trace: { t[], servos[{ id, position[], load[] }], achievedHz, stopped } | null }
 *
 * Traces are left out of the page's rows and read here when a row is opened.
 */
import { error, json } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { getArmMoveTrace } from '$lib/server/robot-arm-move-log';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.user) error(401, 'Unauthorized');
	requirePermission(locals.user, 'manufacturing:read');
	const id = url.searchParams.get('id')?.slice(0, 64);
	if (!id) error(400, 'id is required');
	return json({ trace: await getArmMoveTrace(id) });
};
