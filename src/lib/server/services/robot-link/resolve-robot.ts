/**
 * deviceId (ot2-<slot>-bridge) → OpentronsRobot._id, the inverse of
 * bridgeDeviceIdForRobot() in $lib/server/opentrons/proxy — the one mapping
 * health.ts and the queue use, so a sample is attributed exactly the way the
 * health pill is. Robots are a handful of rows; the lookup is cached briefly
 * per instance because the sampler calls it at most once a minute per device.
 */
import { connectDB, OpentronsRobot } from '$lib/server/db';
import { bridgeDeviceIdForRobot } from '$lib/server/opentrons/proxy';

const CACHE_MS = 5 * 60_000;
let cache: { at: number; byDevice: Map<string, string> } | null = null;

export async function robotIdForDevice(deviceId: string): Promise<string | null> {
	if (!cache || Date.now() - cache.at > CACHE_MS) {
		await connectDB();
		const robots = (await OpentronsRobot.find({ isActive: { $ne: false } })
			.select('_id name bridgeDeviceId')
			.lean()) as { _id: string; name?: string; bridgeDeviceId?: string }[];
		const byDevice = new Map<string, string>();
		for (const r of robots) byDevice.set(bridgeDeviceIdForRobot(r), String(r._id));
		cache = { at: Date.now(), byDevice };
	}
	return cache.byDevice.get(deviceId) ?? null;
}

/** Tests only. */
export function resetRobotDeviceCache(): void {
	cache = null;
}
