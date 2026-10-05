/**
 * Resolve a labware definition the way the maintenance routes do, for the
 * browser's tailnet line (OT2-TAILNET-4): the robot half of load-labware /
 * pick-up-tip runs in the browser, but the definition still comes from BIMS.
 * GET /api/opentrons-lab/labware/resolve?loadName=…[&namespace=…&version=…]
 * → { definition, labwareNamespace, labwareVersion }   (404 when unknown)
 */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import { resolveLabwareForRobot } from '$lib/server/opentrons/maintenance-records';

export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:read');

	const loadName = url.searchParams.get('loadName');
	if (!loadName) error(400, 'loadName required');
	const version = url.searchParams.get('version');
	try {
		const resolved = await resolveLabwareForRobot(loadName, {
			namespace: url.searchParams.get('namespace') || null,
			version: version != null && version !== '' ? Number(version) : null
		});
		return json(JSON.parse(JSON.stringify(resolved)));
	} catch (e) {
		throw error(404, e instanceof Error ? e.message : `Labware definition "${loadName}" not found`);
	}
};
