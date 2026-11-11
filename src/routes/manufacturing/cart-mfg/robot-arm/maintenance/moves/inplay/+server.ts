/**
 * One Arrival row's in-play samples for the Movement Log's Show In Play (2026-11-11).
 *
 *   GET ?id=<move row id>  → { inPlay: { samples[[t, frame, loop, s1..s6]], skipped, ... }, goals[][] } | null
 *
 * Where the arm was during the play, read on the Pi after each frame, with the goals the play sent.
 */
import { error, json } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { getArmMoveInPlay } from '$lib/server/robot-arm-move-log';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.user) error(401, 'Unauthorized');
	requirePermission(locals.user, 'manufacturing:read');
	const id = url.searchParams.get('id')?.slice(0, 64);
	if (!id) error(400, 'id is required');
	return json((await getArmMoveInPlay(id)) ?? { inPlay: null, goals: null });
};
