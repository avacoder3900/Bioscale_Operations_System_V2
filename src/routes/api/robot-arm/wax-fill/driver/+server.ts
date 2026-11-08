/**
 * The arm Pi loop driver's status for the Run tab (2026-11-06).
 *
 *   GET /api/robot-arm/wax-fill/driver  →  { status: { running, loop_id, step, note, error, events[] } | null }
 */
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import { armDriverStatus } from '$lib/server/arm-loop-drive';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:read');
	return json({ status: await armDriverStatus() }, { headers: { 'Cache-Control': 'no-store' } });
};
