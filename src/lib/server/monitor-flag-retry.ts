/**
 * When to re-push the monitor flag to a device (pure decision, no DB, no network).
 *
 * The firmware drops its cloud session for the whole test (~28 min), so a flag push made
 * while a test runs times out and is recorded as 'offline'. A unit that is run back to back
 * has under a minute between tests, which nobody can hit by hand. The one moment the device
 * is certain to be connected is when one of its own events has just arrived: it has finished
 * a test and is waiting for the upload reply, or it has just sent a log.
 */

/** Events a device publishes while connected and not about to drop the link. */
export const FLAG_RETRY_EVENTS = ['upload-test', 'device-log', 'blank-test'];

/** Do not call the same device again within this window (upload-test and device-log arrive seconds apart). */
export const FLAG_RETRY_MIN_GAP_MS = 60_000;

export interface MonitorFlagSnapshot {
	monitoring?: { enabled?: boolean; enabledAt?: Date | string | null; disabledAt?: Date | string | null } | null;
	particleLink?: {
		particleDeviceId?: string | null;
		monitorFlag?: number | null;
		monitorFlagState?: string | null;
		monitorFlagSyncedAt?: Date | string | null;
	} | null;
}

export function monitorFlagNeedsPush(spu: MonitorFlagSnapshot | null | undefined, eventType: string, now: Date = new Date()): boolean {
	if (!spu || !FLAG_RETRY_EVENTS.includes(eventType)) return false;
	if (!spu.particleLink?.particleDeviceId) return false;
	// Never configured for monitoring: leave the device alone.
	const m = spu.monitoring;
	if (!m || (!m.enabledAt && !m.disabledAt && !m.enabled)) return false;

	const state = spu.particleLink.monitorFlagState ?? null;
	// Pre-v103 firmware cannot take the flag; a firmware upgrade is followed by a manual Resync.
	if (state === 'unsupported') return false;

	const want = m.enabled ? 1 : 0;
	if (state === 'synced' && spu.particleLink.monitorFlag === want) return false;

	const last = spu.particleLink.monitorFlagSyncedAt ? new Date(spu.particleLink.monitorFlagSyncedAt).getTime() : 0;
	if (last && now.getTime() - last < FLAG_RETRY_MIN_GAP_MS) return false;
	return true;
}
