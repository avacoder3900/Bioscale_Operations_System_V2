/**
 * Queue-line (bridge daemon) timing rules, kept pure so they can be tested.
 *
 * R04 2026-11-17: every `http` command sat unclaimed for its 30 s TTL while the
 * daemon's heartbeat (due every 10 s) was absent for ~7 minutes; BIMS kept
 * queuing 30 s waits on page loads and a run create on a Pi can itself take
 * 15–30 s. These helpers give a command the TTL its call needs and let a page
 * say "bridge offline" instead of waiting.
 */

/** Default wait for one relayed command — parity with the direct robotFetch abort. */
export const BRIDGE_TIMEOUT_MS = 30_000;
/** Ceiling for a caller-requested wait (run.create asks for ≥ 90 s). */
export const BRIDGE_TTL_MAX_MS = 180_000;
/** A heartbeat older than this means the daemon is not picking up commands. */
export const BRIDGE_HEARTBEAT_STALE_MS = 45_000;

/** The TTL a relayed command gets: the caller's timeout when it is longer than the default, capped. */
export function bridgeTtlMs(timeoutMs?: number | null): number {
	const t = Number(timeoutMs);
	if (!Number.isFinite(t) || t <= BRIDGE_TIMEOUT_MS) return BRIDGE_TIMEOUT_MS;
	return Math.min(t, BRIDGE_TTL_MAX_MS);
}

/** Banner for a page when the robot's bridge daemon is not heartbeating; null when it is. */
export function bridgeOfflineBanner(heartbeatAgeMs: number | null): string | null {
	if (heartbeatAgeMs == null) return 'robot bridge has never reported in — start not checked';
	if (heartbeatAgeMs < BRIDGE_HEARTBEAT_STALE_MS) return null;
	const s = Math.round(heartbeatAgeMs / 1000);
	const ago = s < 90 ? `${s} s` : `${Math.round(s / 60)} min`;
	return `robot bridge offline — last heartbeat ${ago} ago; start not checked`;
}
