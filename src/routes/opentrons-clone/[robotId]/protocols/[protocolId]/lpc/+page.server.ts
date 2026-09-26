/**
 * Labware Position Check — server gate only (OT2-TAILNET-5 S10c).
 * LPC moves the robot, so it keeps its manufacturing:write gate here; the
 * protocol / analysis / instruments are read in the browser (+page.ts) and the
 * wizard drives the maintenance run over the robot session.
 */
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'manufacturing:write');
	return {};
};
