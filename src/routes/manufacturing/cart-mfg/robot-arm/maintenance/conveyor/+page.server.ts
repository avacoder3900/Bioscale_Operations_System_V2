/**
 * Robot Arm — Maintenance → Conveyor: bench test of the wax-fill cooling belt
 * on the arm Pi's BCM 22 (physical pin 15). The same ConveyorPanel sits under
 * the trapdoor solenoids on Teach; load and actions live in
 * $lib/server/robot-arm-conveyor. The Pi side (services/robot-arm/src/server/
 * conveyor.py) stays when this page goes.
 */
import { redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { conveyorActions, loadConveyor } from '$lib/server/robot-arm-conveyor';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	return { conveyor: await loadConveyor() };
};

export const actions: Actions = { ...conveyorActions };
