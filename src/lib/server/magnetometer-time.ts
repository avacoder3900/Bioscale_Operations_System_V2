// When did the magnetometer test actually RUN?
//
// BIMS reads magnetometer results by polling a Particle variable that the device
// holds from a previous run_test. Both read paths used to stamp the session with
// `new Date()` — the moment of the PULL — which is not the same thing at all. If
// the variable is stale (a known failure mode; see the SPU-203 stale-read
// incident), a months-old result gets recorded as if it had just been measured.
// Measured against production on 2026-07-30: 153 of 413 magnetometer sessions
// were mislabelled by more than an hour, the worst by 248 days.
//
// The device already tells us when the test ran. The payload's first line carries
// a Unix timestamp in one of two shapes, so parse it rather than guessing.

export type MagTimeSource = 'filename' | 'counter';

export interface MagTestTime {
	at: Date;
	epoch: number;
	source: MagTimeSource;
}

/** Device clocks can come up unset. Anything outside this window is not a real
 *  test time, and a wrong date is worse than an honest "unknown". */
const EARLIEST = Date.UTC(2020, 0, 1);
/** Small allowance for clock skew between the device and this server. */
const FUTURE_SLACK_MS = 24 * 60 * 60 * 1000;

/** Seconds or milliseconds — 13-digit values are already ms. */
function toMillis(n: number): number {
	return n >= 1e12 ? n : n * 1000;
}

/**
 * Pull the test's run time out of a raw magnet_validation payload.
 *
 * Recognises, in priority order:
 *   1. the results filename the firmware writes, e.g.
 *        /validation/magnet-1784661523.txt          (403 of 426 sessions in prod)
 *   2. a counter + epoch header, e.g.
 *        #003<TAB>1710268200                        (10 of 426)
 *
 * Returns null when there is no usable timestamp — including the legacy payloads
 * that begin "Channel A ... Channel B ... Channel C" (13 of 426), which never
 * carried one. Callers must render that as unknown; silently falling back to the
 * pull time is the bug this function exists to fix.
 */
export function extractMagTestTime(rawData: unknown): MagTestTime | null {
	if (typeof rawData !== 'string' || rawData.length === 0) return null;

	// The timestamp lives in the header; don't scan a whole results table for
	// digits that might coincidentally look like an epoch.
	const head = rawData.slice(0, 400);

	const candidates: Array<{ epoch: number; source: MagTimeSource }> = [];

	const file = head.match(/magnet-(\d{9,13})\.txt/);
	if (file) candidates.push({ epoch: Number(file[1]), source: 'filename' });

	const counter = head.match(/^\s*#(\d+)\t(\d{9,13})/);
	if (counter) candidates.push({ epoch: Number(counter[2]), source: 'counter' });

	for (const c of candidates) {
		if (!Number.isFinite(c.epoch)) continue;
		const ms = toMillis(c.epoch);
		if (ms < EARLIEST) continue;
		if (ms > Date.now() + FUTURE_SLACK_MS) continue;
		return { at: new Date(ms), epoch: c.epoch, source: c.source };
	}

	return null;
}

/**
 * How far ahead of the actual test the reading was taken. Null when the test time
 * is unknown. Negative values are clamped to 0 — they would mean clock skew, not
 * a stale read.
 */
export function pullDelaySeconds(testAt: Date | null, pulledAt: Date | null): number | null {
	if (!testAt || !pulledAt) return null;
	return Math.max(0, Math.round((pulledAt.getTime() - testAt.getTime()) / 1000));
}

/** Above this the reading is old enough that the UI should say so out loud. */
export const STALE_AFTER_SECONDS = 3600;
