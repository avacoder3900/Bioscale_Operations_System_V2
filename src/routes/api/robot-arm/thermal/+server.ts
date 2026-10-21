/**
 * Arm Pi thermal state, for the camera card on every Robot Arm tab.
 *
 *   GET → { thermal: ArmThermal | null, installed: boolean, error: string | null }
 *
 * Reads GET /health/thermal on the Pi (services/robot-arm/src/server/thermal.py):
 * SoC temperature, the firmware's throttle flags (throttled / clock capped /
 * soft temperature limit / under-voltage, now and since boot), clock, and the
 * service's own CPU use. The fanless Pi 5 reached 84 °C with the firmware's
 * soft limit active at 1080p@30 on 2026-10-21; before this the only symptom
 * BIMS could see was a slower feed.
 *
 * Episodes are logged to the shared `device_events` collection (deviceId
 * robot-arm-pi, eventType robot_arm.thermal) so they can be looked up after
 * the fact: one row when the level changes, and a heartbeat row at most
 * every 10 minutes while the level is hot or critical. Nothing is written
 * while the Pi is simply ok, so /devices (which lists events unfiltered) is
 * not buried. Never throws for a missing or unreachable Pi: the card just
 * shows nothing.
 */
import { error, json } from '@sveltejs/kit';
import { connectDB, DeviceEvent } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import { robotArm, type ArmThermal } from '$lib/server/robot-arm-client';
import type { RequestHandler } from './$types';

const ARM_DEVICE_ID = 'robot-arm-pi';
const THERMAL_EVENT = 'robot_arm.thermal';
/** Same-level heartbeat floor while hot/critical. */
const HEARTBEAT_MS = 10 * 60 * 1000;
/** A level change still waits this long after the previous row (flapping around a threshold). */
const CHANGE_DEDUPE_MS = 30_000;

async function logEpisode(t: ArmThermal): Promise<void> {
	await connectDB();
	const last = (await DeviceEvent.findOne({ deviceId: ARM_DEVICE_ID, eventType: THERMAL_EVENT })
		.sort({ createdAt: -1 })
		.select('eventData createdAt')
		.lean()) as { eventData?: { level?: string }; createdAt?: Date } | null;
	const lastLevel = last?.eventData?.level ?? 'ok';
	const age = last?.createdAt ? Date.now() - new Date(last.createdAt).getTime() : Number.POSITIVE_INFINITY;
	const serious = t.level === 'hot' || t.level === 'critical';
	const changed = t.level !== lastLevel;
	const write = changed ? age > CHANGE_DEDUPE_MS && (serious || lastLevel !== 'ok') : serious && age > HEARTBEAT_MS;
	if (!write) return;
	await DeviceEvent.create({
		deviceId: ARM_DEVICE_ID,
		eventType: THERMAL_EVENT,
		success: !serious,
		errorMessage: serious ? `Pi ${t.level}: ${t.temp_c ?? '?'} °C${t.now.length ? ` (${t.now.join(', ')})` : ''}` : null,
		eventData: {
			level: t.level,
			previousLevel: lastLevel,
			tempC: t.temp_c,
			now: t.now,
			sinceBoot: t.since_boot,
			clockMhz: t.clock_mhz,
			clockMaxMhz: t.clock_max_mhz,
			serviceCpuPct: t.service_cpu_pct,
			load1m: t.load_1m,
			throttledHex: t.throttled_hex
		}
	});
}

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:read');
	const headers = { 'Cache-Control': 'no-store' };
	let thermal: ArmThermal;
	try {
		thermal = await robotArm.getThermal({ timeoutMs: 3000 });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		// 404: the Pi has not had scripts/install_thermal_router.py run yet.
		return json({ thermal: null, installed: !/robot-arm 404/.test(msg), error: msg }, { headers });
	}
	try {
		await logEpisode(thermal);
	} catch (err) {
		console.warn('[arm-thermal] episode not logged:', err instanceof Error ? err.message : err);
	}
	return json({ thermal, installed: true, error: null }, { headers });
};
