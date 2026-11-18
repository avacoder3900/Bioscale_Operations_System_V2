/**
 * Close the chute scan warning (2026-11-16): every failed chute scan up to now
 * is dismissed for everyone, and an audit row says who closed it. A later
 * failed scan raises the warning again.
 *
 *   POST /api/robot-arm/chute-scans/close   session → { closed }
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import { closeChuteWarning } from '$lib/server/robot-arm-chute-scan';

export const POST: RequestHandler = async ({ locals }) => {
	requirePermission(locals.user, 'manufacturing:write');
	const user = locals.user!;
	return json({ closed: await closeChuteWarning({ _id: user._id, username: user.username }) });
};
