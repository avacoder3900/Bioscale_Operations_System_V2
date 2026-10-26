/**
 * Daemon-side connectivity sampling off the heartbeat (OT2-LOG-1 L2a).
 *
 * The on-robot daemon posts a heartbeat every ~10 s; from OT2-LOG-1 L3 on,
 * `metadata.link` carries the link telemetry (PRD §2/§3):
 *
 *   link: {
 *     iface:     { default: 'eth0'|'wlan0'|null, eth0: {carrier, ip}, wlan0: {ip, rssi, freq} },
 *     tailscale: { direct, relay, curAddr, handshakeAgeS },
 *     bims:      { pollRttMs, pollErrors, hbErrors },
 *     worker:    { busyAgeS, queueDepth },
 *     daemon:    { version, sha256, uptimeS, journalBacklog }
 *   }
 *
 * The heartbeat doc itself stays ONE overwritten row per device (the 2026-07-31
 * Atlas incident was one row per ping). This module turns at most one
 * heartbeat a minute into a RobotLinkSample: a sample is written only when the
 * device's newest daemon sample is ≥ SAMPLE_MIN_GAP_MS old. ≈ 4.3k docs/day for
 * three robots. The server block is derived from metadata.health / .engine the
 * way health.ts reads them.
 */
import { connectDB, RobotLinkSample, generateId } from '$lib/server/db';
import { robotIdForDevice } from './resolve-robot';

export const SAMPLE_MIN_GAP_MS = 55_000;

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown, max = 200): string | undefined => (typeof v === 'string' ? v.slice(0, max) : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** Pure: the sample document for one heartbeat. Exported for tests. */
export function daemonSampleFromHeartbeat(args: {
	deviceId: string;
	robotId: string | null;
	metadata: Record<string, unknown>;
	now: Date;
	/** receivedAt of the heartbeat this one replaced; null on the first ever. */
	prevReceivedAt: Date | null;
}): Record<string, unknown> {
	const { deviceId, robotId, metadata, now, prevReceivedAt } = args;
	const link = obj(metadata.link) ?? {};
	const iface = obj(link.iface);
	const eth0 = iface ? obj(iface.eth0) : null;
	const wlan0 = iface ? obj(iface.wlan0) : null;
	const ts = obj(link.tailscale);
	const bims = obj(link.bims);
	const worker = obj(link.worker);
	const daemon = obj(link.daemon);
	const engine = obj(metadata.engine);
	const hbAgeAtReceiptMs = prevReceivedAt ? Math.max(0, now.getTime() - prevReceivedAt.getTime()) : undefined;

	return {
		_id: generateId(),
		robotId,
		deviceId,
		at: now,
		source: 'daemon',
		iface: iface
			? {
					default: str(iface.default, 16) ?? null,
					eth0: eth0 ? { carrier: bool(eth0.carrier), ip: str(eth0.ip, 64) } : undefined,
					wlan0: wlan0 ? { ip: str(wlan0.ip, 64), rssi: num(wlan0.rssi), freq: num(wlan0.freq) } : undefined
				}
			: undefined,
		tailscale: ts
			? { direct: bool(ts.direct), relay: str(ts.relay, 64) ?? null, curAddr: str(ts.curAddr, 64) ?? null, handshakeAgeS: num(ts.handshakeAgeS) ?? null }
			: undefined,
		bims: {
			pollRttMs: num(bims?.pollRttMs),
			pollErrors: num(bims?.pollErrors),
			hbErrors: num(bims?.hbErrors),
			hbAgeAtReceiptMs
		},
		worker: worker ? { busyAgeS: num(worker.busyAgeS), queueDepth: num(worker.queueDepth) } : undefined,
		daemon: {
			version: str(daemon?.version, 64) ?? str(metadata.version, 64),
			sha256: str(daemon?.sha256, 64),
			uptimeS: num(daemon?.uptimeS),
			journalBacklog: num(daemon?.journalBacklog)
		},
		server: { healthOk: !!metadata.health, engineOk: engine?.engineOk !== false }
	};
}

/**
 * Write a daemon sample for this heartbeat if the device's last one is old
 * enough. Never throws — a sampling failure must not fail the heartbeat.
 * Returns what the route logs.
 */
export async function sampleHeartbeatLink(args: {
	deviceId: string;
	metadata: Record<string, unknown> | undefined;
	now: Date;
	prevReceivedAt: Date | null;
}): Promise<{ sampled: boolean; ageMs: number | null }> {
	const { deviceId, metadata, now, prevReceivedAt } = args;
	const ageMs = prevReceivedAt ? Math.max(0, now.getTime() - prevReceivedAt.getTime()) : null;
	if (!metadata || !obj(metadata.link)) return { sampled: false, ageMs };
	try {
		await connectDB();
		const last = (await RobotLinkSample.findOne({ deviceId, source: 'daemon' })
			.sort({ at: -1 })
			.select('at')
			.lean()) as { at?: Date } | null;
		if (last?.at && now.getTime() - new Date(last.at).getTime() < SAMPLE_MIN_GAP_MS) {
			return { sampled: false, ageMs };
		}
		const robotId = await robotIdForDevice(deviceId).catch(() => null);
		await RobotLinkSample.create(daemonSampleFromHeartbeat({ deviceId, robotId, metadata, now, prevReceivedAt }));
		return { sampled: true, ageMs };
	} catch (err) {
		console.warn('[robot-link] heartbeat sample failed', deviceId, (err as Error)?.message ?? err);
		return { sampled: false, ageMs };
	}
}
