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
 *   - /health/thermal — sysfs + vcgencmd on the Pi; feeds the heat/throttle
 *     chip on the camera card. 404 until the route is installed on the Pi.
 *   - one Mongo findOne on `device_events`, only while the arm is down, so the
 *     ARM CONNECTION panel in the right rail can still say when it last worked.
 *     The connection log itself is still written by the Control tab's load.
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
import { connectDB } from '$lib/server/db/connection';
import { DeviceEvent } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import {
	robotArm,
	currentArmRoute,
	type ArmPreflight,
	type ArmThermal,
	type CameraStatus
} from '$lib/server/robot-arm-client';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');

	const [preflightResult, camerasResult, thermalResult] = await Promise.allSettled([
		robotArm.preflight({ timeoutMs: 3000 }),
		robotArm.listCameras(),
		robotArm.getThermal({ timeoutMs: 3000 })
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

	// Belt-and-braces: this load feeds a panel rendered in the *layout*, so any
	// non-array here 500s all four arm tabs at once rather than degrading to a
	// single broken panel. Never hand the panel something it can't .find() on.
	const cameras: CameraStatus[] =
		camerasResult.status === 'fulfilled' && Array.isArray(camerasResult.value)
			? camerasResult.value
			: [];

	const camerasError =
		camerasResult.status === 'rejected'
			? camerasResult.reason instanceof Error
				? camerasResult.reason.message
				: 'Unreachable'
			: null;

	// Soft as well: a Pi without the thermal route (404) or a slow answer just
	// means no chip until the client-side poll gets one.
	const thermal: ArmThermal | null = thermalResult.status === 'fulfilled' ? thermalResult.value : null;

	// "Last connected" for the ARM CONNECTION panel. Up: this request is the
	// proof. Down: the newest success row in the connection log the Control tab
	// writes (see recordConnection there). Soft — telemetry never 500s the tabs.
	let lastConnected: string | null = null;
	if (preflight !== null) {
		lastConnected = new Date().toISOString();
	} else {
		try {
			await connectDB();
			const row = await DeviceEvent.findOne({
				deviceId: 'robot-arm-pi',
				eventType: 'robot_arm.connection',
				success: true
			})
				.select('createdAt')
				.sort({ createdAt: -1 })
				.lean();
			lastConnected = row ? new Date(row.createdAt as Date).toISOString() : null;
		} catch {
			lastConnected = null;
		}
	}

	return {
		arm: {
			reachable: preflight !== null,
			preflight,
			error: armError,
			// Operator-facing diagnostic text, no key in it: the single most useful
			// string when the arm is misconfigured.
			baseUrl: currentArmRoute(),
			lastConnected
		},
		cameras,
		camerasError,
		thermal
	};
};
