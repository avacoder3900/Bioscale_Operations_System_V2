/**
 * Resolve a labware definition the way the maintenance routes do, for the
 * browser's tailnet line (OT2-TAILNET-4): the robot half of load-labware /
 * pick-up-tip runs in the browser, but the definition still comes from BIMS.
 * GET /api/opentrons-lab/labware/resolve?loadName=…[&namespace=…&version=…][&robotId=…&slot=…]
 * → { definition, labwareNamespace, labwareVersion, labwareOffset? }   (404 when unknown)
 *
 * robotId + slot (CALIB-5): for a rack in its slot (10/11) the answer also
 * carries that robot's labwareOffset, exactly as the load-labware / pick-up-tip
 * routes resolve it, so the tailnet line registers the same offset.
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
	const slot = url.searchParams.get('slot');
	try {
		const resolved = await resolveLabwareForRobot(loadName, {
			namespace: url.searchParams.get('namespace') || null,
			version: version != null && version !== '' ? Number(version) : null,
			robotId: url.searchParams.get('robotId') || null,
			slot: slot != null && slot !== '' ? slot : null
		});
		return json(JSON.parse(JSON.stringify(resolved)));
	} catch (e) {
		throw error(404, e instanceof Error ? e.message : `Labware definition "${loadName}" not found`);
	}
};
