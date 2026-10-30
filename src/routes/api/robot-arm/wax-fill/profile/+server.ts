/**
 * Fill profile of a robot-arm wax-fill loop: where the OT-2 run's seconds went,
 * per cart and per station, from the robot's own command log.
 *
 *   GET ?loopId=<ArmWaxFillRun _id>[&refresh=1] → { profile: RunProfile }
 *
 * Cached on the loop once its run is over; `refresh=1` reads the robot again.
 */
import { json } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { FillProfileError, loopFillProfile } from '$lib/server/arm-wax-fill-profile';
import type { RequestHandler } from './$types';

export const config = { maxDuration: 120 };

export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.user) return json({ error: 'Not authenticated' }, { status: 401 });
	requirePermission(locals.user, 'manufacturing:read');
	const loopId = url.searchParams.get('loopId')?.trim() ?? '';
	if (!loopId) return json({ error: 'loopId missing.' }, { status: 400 });
	try {
		const profile = await loopFillProfile(loopId, { refresh: url.searchParams.get('refresh') === '1' });
		return json({ profile }, { headers: { 'Cache-Control': 'no-store' } });
	} catch (err) {
		if (err instanceof FillProfileError) return json({ error: err.message }, { status: err.status });
		console.error('[arm-wax-fill-profile]', err);
		return json({ error: err instanceof Error ? err.message : 'Unexpected error.' }, { status: 500 });
	}
};
