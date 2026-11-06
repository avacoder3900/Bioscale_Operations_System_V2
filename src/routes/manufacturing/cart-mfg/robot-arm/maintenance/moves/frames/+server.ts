/**
 * One play's frames for the Movement Log's Show Frames (2026-11-06).
 *
 *   GET ?id=<move row id>  → { frames: { rateHz, t[], goals[][], fires[] } | null }
 *
 * Frames are left out of the page's rows (a long recording is thousands of
 * them) and read here when a row is opened.
 */
import { error, json } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { getArmMoveFrames } from '$lib/server/robot-arm-move-log';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.user) error(401, 'Unauthorized');
	requirePermission(locals.user, 'manufacturing:read');
	const id = url.searchParams.get('id')?.slice(0, 64);
	if (!id) error(400, 'id is required');
	return json({ frames: await getArmMoveFrames(id) });
};
