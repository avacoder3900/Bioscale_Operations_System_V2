import { describe, it, expect } from 'vitest';
import { bridgeTtlMs, bridgeOfflineBanner, BRIDGE_TIMEOUT_MS, BRIDGE_TTL_MAX_MS, BRIDGE_HEARTBEAT_STALE_MS } from './bridge-timing';

describe('bridgeTtlMs', () => {
	it('is the 30 s default unless the call asks for longer, capped at 180 s', () => {
		expect(bridgeTtlMs()).toBe(BRIDGE_TIMEOUT_MS);
		expect(bridgeTtlMs(null)).toBe(BRIDGE_TIMEOUT_MS);
		expect(bridgeTtlMs(10_000)).toBe(BRIDGE_TIMEOUT_MS);
		expect(bridgeTtlMs(90_000)).toBe(90_000); // run.create on a Pi
		expect(bridgeTtlMs(10 * 60_000)).toBe(BRIDGE_TTL_MAX_MS);
		expect(bridgeTtlMs(Number.NaN)).toBe(BRIDGE_TIMEOUT_MS);
	});
});

describe('bridgeOfflineBanner', () => {
	it('is silent while the daemon heartbeats, and names the gap once it is stale', () => {
		expect(bridgeOfflineBanner(10_000)).toBeNull();
		expect(bridgeOfflineBanner(BRIDGE_HEARTBEAT_STALE_MS - 1)).toBeNull();
		expect(bridgeOfflineBanner(70_000)).toBe('robot bridge offline — last heartbeat 70 s ago; start not checked');
		expect(bridgeOfflineBanner(7 * 60_000)).toBe('robot bridge offline — last heartbeat 7 min ago; start not checked');
		expect(bridgeOfflineBanner(null)).toMatch(/never reported in/);
	});
});
