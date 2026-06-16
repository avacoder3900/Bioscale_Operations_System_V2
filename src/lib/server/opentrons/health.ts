/**
 * Robot health — derived from the bridge daemon's heartbeat (ScannerEvent
 * eventType:'heartbeat'), which the daemon posts every ~10s with both /health
 * and a deeper engine-readiness probe (see scripts/ot2-bridge.py engine_health).
 *
 * IMPORTANT: /health alone is a liar — it stays 200 even when the OT-2 run
 * engine is hung. So 'ready' requires the engine probe to be reachable, not
 * just the server alive.
 */

import { ScannerEvent } from '$lib/server/db';
import { bridgeDeviceIdForRobot } from './proxy';

// Heartbeat cadence is ~10s; allow 6 missed beats before calling it offline.
const HEARTBEAT_STALE_MS = 60_000;

// Protocol-run states that mean the robot is occupied (not 'ready').
const ACTIVE_PROTOCOL = new Set([
	'running',
	'finishing',
	'paused',
	'blocked-by-open-door',
	'awaiting-recovery'
]);

export type RobotHealthStatus = 'ready' | 'busy' | 'hung' | 'offline';

export interface RobotHealth {
	status: RobotHealthStatus;
	label: string;
	detail: string;
	bridgeOnline: boolean;
	serverOk: boolean;
	engineOk: boolean;
	protocolRun: string | null;
	maintenanceRun: string | null;
	lastBeatMsAgo: number | null;
}

function compute(meta: any, ageMs: number | null): RobotHealth {
	const bridgeOnline = ageMs != null && ageMs <= HEARTBEAT_STALE_MS;
	const serverOk = !!meta?.health;
	const engine = meta?.engine ?? {};
	// Older daemons (pre engine-probe) won't send `engine` — don't flag those as
	// hung; default engineOk true when the field is absent.
	const engineOk = engine?.engineOk !== false;
	const protocolRun: string | null = engine?.protocolRun ?? null;
	const maintenanceRun: string | null = engine?.maintenanceRun ?? null;

	let status: RobotHealthStatus;
	let label: string;
	let detail: string;

	if (ageMs == null) {
		status = 'offline';
		label = 'Offline';
		detail = 'No bridge heartbeat ever received — is the daemon running?';
	} else if (!bridgeOnline) {
		status = 'offline';
		label = 'Offline';
		detail = `Bridge silent for ${Math.round(ageMs / 1000)}s — daemon down or network lost`;
	} else if (!serverOk || !engineOk) {
		status = 'hung';
		label = 'Engine hung';
		detail = 'Robot server is up but not answering run commands — restart it';
	} else if (maintenanceRun) {
		status = 'busy';
		label = 'Busy (scan/jog)';
		detail = `Maintenance run active (${maintenanceRun})`;
	} else if (protocolRun && ACTIVE_PROTOCOL.has(String(protocolRun).toLowerCase())) {
		status = 'busy';
		label = 'Running';
		detail = `Protocol run ${protocolRun}`;
	} else {
		status = 'ready';
		label = 'Ready';
		detail = 'Ready to receive and run protocols';
	}

	return {
		status,
		label,
		detail,
		bridgeOnline,
		serverOk,
		engineOk,
		protocolRun,
		maintenanceRun,
		lastBeatMsAgo: ageMs
	};
}

/**
 * Map of robotId -> RobotHealth for the given robots, read from the latest
 * heartbeat per robot's bridge device. Safe: never throws (returns 'offline'
 * for any robot whose heartbeat can't be read).
 */
export async function getRobotsHealth(
	robots: { _id: string; name?: string | null }[]
): Promise<Record<string, RobotHealth>> {
	const out: Record<string, RobotHealth> = {};
	await Promise.all(
		robots.map(async (r) => {
			const deviceId = bridgeDeviceIdForRobot({ name: r.name ?? undefined });
			const beat = (await ScannerEvent.findOne({ deviceId, eventType: 'heartbeat' })
				.sort({ receivedAt: -1 })
				.select('receivedAt metadata')
				.lean()
				.catch(() => null)) as any;
			const ageMs = beat?.receivedAt ? Date.now() - new Date(beat.receivedAt).getTime() : null;
			out[String(r._id)] = compute(beat?.metadata, ageMs);
		})
	);
	return out;
}
