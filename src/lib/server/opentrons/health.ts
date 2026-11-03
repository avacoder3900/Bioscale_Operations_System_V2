/**
 * Robot health — derived from the bridge daemon's heartbeat (ScannerEvent
 * eventType:'heartbeat'), which the daemon posts every ~10s with both /health
 * and a deeper engine-readiness probe (see scripts/ot2-bridge.py engine_health).
 *
 * IMPORTANT: /health alone is a liar — it stays 200 even when the OT-2 run
 * engine is hung. So 'ready' requires the engine probe to be reachable, not
 * just the server alive.
 */

import { ScannerEvent, Ot2BridgeCommand } from '$lib/server/db';
import { bridgeDeviceIdForRobot } from './proxy';

// Heartbeat cadence is ~10s; allow 6 missed beats before calling it offline.
const HEARTBEAT_STALE_MS = 60_000;

/**
 * RESTART WINDOW (2026-11-03, B14): the robot server boots for 2–3 min after a
 * Recover, and during that boot the engine probe fails — which used to read as
 * "Engine hung" and invite another Recover (each one killed the boot and
 * blocked the daemon's worker for another 3 min). A restart issued inside this
 * window is "Restarting" while the engine is silent, and the restart endpoint
 * refuses a second one. 1.6.0 daemons also report the restart themselves.
 */
export const RESTART_WINDOW_MS = 240_000;

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
	/** ISO time the robot server restart began, while it is still booting. */
	restartingSince?: string | null;
}

/**
 * @param recentRestartMs age of a `restart_robot_server` issued inside the
 * window (see recentRestartAgeMs), for daemons that don't report `restarting`.
 */
export function computeHealth(meta: any, ageMs: number | null, recentRestartMs: number | null = null): RobotHealth {
	const bridgeOnline = ageMs != null && ageMs <= HEARTBEAT_STALE_MS;
	const serverOk = !!meta?.health;
	const engine = meta?.engine ?? {};
	// Older daemons (pre engine-probe) won't send `engine` — don't flag those as
	// hung; default engineOk true when the field is absent.
	const engineOk = engine?.engineOk !== false;
	const protocolRun: string | null = engine?.protocolRun ?? null;
	const maintenanceRun: string | null = engine?.maintenanceRun ?? null;
	// A restart in flight: reported by the daemon (1.6.0), else inferred from a
	// recent restart command while the engine is not answering.
	const reported = engine?.restarting && typeof engine.restarting === 'object' ? engine.restarting : null;
	const restartAgeMs: number | null = reported
		? Math.max(0, Number(reported.secondsAgo ?? 0)) * 1000
		: recentRestartMs != null && (!serverOk || !engineOk)
			? recentRestartMs
			: null;
	const restartingSince = restartAgeMs == null ? null : new Date(Date.now() - restartAgeMs).toISOString();

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
	} else if (restartAgeMs != null) {
		status = 'busy';
		label = 'Restarting';
		detail = `Robot server restarting (${Math.round(restartAgeMs / 1000)}s ago; boot takes 2–3 min) — wait, don't press Recover again`;
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
		lastBeatMsAgo: ageMs,
		restartingSince
	};
}

/**
 * Age of a restart_robot_server command that still counts as "in flight": inside
 * the window, not expired (never picked up — a retry is legitimate) and not
 * refused by the daemon (`restarted:false` without `alreadyStarting`, e.g. a
 * live run). An old daemon's `failed` ("did not come back" after its 90 s wait)
 * still counts — the server is booting.
 */
export function recentRestartAgeMs(cmd: { createdAt?: Date | string; status?: string; result?: any } | null | undefined, now = Date.now()): number | null {
	if (!cmd?.createdAt) return null;
	const age = now - new Date(cmd.createdAt).getTime();
	if (!(age >= 0 && age <= RESTART_WINDOW_MS)) return null;
	if (cmd.status === 'expired') return null;
	const body = cmd.result?.body;
	if (body && body.restarted === false && !body.alreadyStarting) return null;
	return age;
}

async function latestBeat(deviceId: string): Promise<any> {
	return (await ScannerEvent.findOne({ deviceId, eventType: 'heartbeat' })
		.sort({ receivedAt: -1 })
		.select('receivedAt metadata')
		.lean()
		.catch(() => null)) as any;
}

async function recentRestartCommand(deviceId: string, now: number): Promise<any> {
	return (await Ot2BridgeCommand.findOne({
		deviceId,
		kind: 'restart_robot_server',
		createdAt: { $gte: new Date(now - RESTART_WINDOW_MS) }
	})
		.sort({ createdAt: -1 })
		.select('createdAt status result requestedBy')
		.lean()
		.catch(() => null)) as any;
}

/**
 * Is a robot-server restart under way on this robot? For the restart endpoint:
 * the daemon's own report (fresh heartbeat), else any restart command issued
 * inside the window (whatever the engine says — the badge is what the operator
 * reads, this is what stops the second press).
 */
export async function restartInProgress(robot: { _id: string; name?: string | null }): Promise<{ ageS: number; by: string | null } | null> {
	const deviceId = bridgeDeviceIdForRobot({ name: robot.name ?? undefined });
	const now = Date.now();
	const [beat, cmd] = await Promise.all([latestBeat(deviceId), recentRestartCommand(deviceId, now)]);
	const reported = beat?.metadata?.engine?.restarting;
	const fresh = beat?.receivedAt && now - new Date(beat.receivedAt).getTime() <= HEARTBEAT_STALE_MS;
	if (fresh && reported && typeof reported === 'object') return { ageS: Math.max(0, Number(reported.secondsAgo ?? 0)), by: cmd?.requestedBy ?? null };
	const ms = recentRestartAgeMs(cmd, now);
	return ms == null ? null : { ageS: Math.round(ms / 1000), by: cmd?.requestedBy ?? null };
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
			const now = Date.now();
			const [beat, cmd] = await Promise.all([latestBeat(deviceId), recentRestartCommand(deviceId, now)]);
			const ageMs = beat?.receivedAt ? now - new Date(beat.receivedAt).getTime() : null;
			out[String(r._id)] = computeHealth(beat?.metadata, ageMs, recentRestartAgeMs(cmd, now));
		})
	);
	return out;
}

/**
 * The legacy robot pages (/opentrons hub, devices list, device page, new run)
 * used to render `OpentronsRobot.lastHealthOk / lastHealthAt`, fields written
 * by a server-side poller that was retired with the move to Tailscale — so every
 * robot showed "offline" forever (2026-10-13). They now derive the same fields
 * from the daemon heartbeat, the one source every other surface uses.
 */
export interface HeartbeatFields {
	/** true = bridge heard within HEARTBEAT_STALE_MS and the robot server answered it. */
	lastHealthOk: boolean;
	/** ISO time of the newest heartbeat, or null if none was ever received. */
	lastHealthAt: string | null;
	healthStatus: RobotHealthStatus;
	healthLabel: string;
	healthDetail: string;
}

export function heartbeatFields(h: RobotHealth | undefined): HeartbeatFields {
	if (!h) {
		return { lastHealthOk: false, lastHealthAt: null, healthStatus: 'offline', healthLabel: 'Offline', healthDetail: 'No heartbeat' };
	}
	return {
		lastHealthOk: h.bridgeOnline && h.serverOk,
		lastHealthAt: h.lastBeatMsAgo == null ? null : new Date(Date.now() - h.lastBeatMsAgo).toISOString(),
		healthStatus: h.status,
		healthLabel: h.label,
		healthDetail: h.detail
	};
}
