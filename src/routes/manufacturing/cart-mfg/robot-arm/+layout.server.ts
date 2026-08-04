/**
 * ARM-02 — shared load for the consolidated Robot Arm page.
 *
 * Deliberately narrow. This runs on all four tabs, and SvelteKit runs layout
 * loads *concurrently* with page loads, so anything expensive here is paid on
 * top of the slowest child. The calibrate load already spends 25s of a 30s
 * adapter budget on sequential serial-bus calls (see getCalibration in
 * robot-arm-client.ts), leaving ~5s of headroom.
 *
 * So the rule is: only endpoints that are cheap AND touch no serial bus.
 *   - /health/preflight — checks port *presence* against comports(); never
 *     opens the bus. Capped at 3s here rather than the client default of 8s.
 *   - /cameras — cameras.py status() explicitly does not start workers and
 *     does not touch the servos.
 *
 * Everything else (getActive, getCalibration, getJointMap) stays in the child
 * loads where its budget is already accounted for. Deduplicating getActive
 * into this layout is the obvious follow-up and is deliberately NOT done here
 * — it would rewrite three load functions inside the tightest timeout budget
 * in the codebase.
 *
 * Failures are soft. An unreachable Pi must still render the tab strip and
 * the Runs tab, which reads Mongo and does not need the arm at all.
 */
import { redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { robotArm, type ArmPreflight, type CameraStatus } from '$lib/server/robot-arm-client';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');

	const [preflightResult, camerasResult] = await Promise.allSettled([
		robotArm.preflight({ timeoutMs: 3000 }),
		robotArm.listCameras()
	]);

	const preflight: ArmPreflight | null =
		preflightResult.status === 'fulfilled' ? preflightResult.value : null;

	// The base URL is safe to show: it is operator-facing diagnostic text and
	// contains no key. It is the single most useful string when the arm is
	// misconfigured (ARM-01 found local .env pointing at a stray :8001 that
	// the Funnel does not proxy, which 404s every camera endpoint).
	const armError =
		preflightResult.status === 'rejected'
			? preflightResult.reason instanceof Error
				? preflightResult.reason.message
				: 'Unreachable'
			: null;

	const cameras: CameraStatus[] =
		camerasResult.status === 'fulfilled' ? camerasResult.value : [];

	const camerasError =
		camerasResult.status === 'rejected'
			? camerasResult.reason instanceof Error
				? camerasResult.reason.message
				: 'Unreachable'
			: null;

	return {
		arm: {
			reachable: preflight !== null,
			preflight,
			error: armError
		},
		cameras,
		camerasError
	};
};
