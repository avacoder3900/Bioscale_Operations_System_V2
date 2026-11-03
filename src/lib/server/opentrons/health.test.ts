/**
 * heartbeatFields(): the legacy robot pages' lastHealthOk/lastHealthAt now come
 * from the daemon heartbeat (health.ts), not the dead OpentronsRobot fields.
 */
import { describe, it, expect } from 'vitest';
import { heartbeatFields, computeHealth, recentRestartAgeMs, RESTART_WINDOW_MS, type RobotHealth } from './health';

const base: RobotHealth = {
	status: 'ready',
	label: 'Ready',
	detail: 'Ready to receive and run protocols',
	bridgeOnline: true,
	serverOk: true,
	engineOk: true,
	protocolRun: null,
	maintenanceRun: null,
	lastBeatMsAgo: 1200
};

describe('heartbeatFields', () => {
	it('a fresh heartbeat with a healthy server → online, with the beat time', () => {
		const f = heartbeatFields(base);
		expect(f.lastHealthOk).toBe(true);
		expect(f.healthStatus).toBe('ready');
		expect(Date.now() - new Date(f.lastHealthAt!).getTime()).toBeGreaterThanOrEqual(1200);
	});
	it('a running protocol is online and labelled busy', () => {
		const f = heartbeatFields({ ...base, status: 'busy', label: 'Running', protocolRun: 'running' });
		expect(f).toMatchObject({ lastHealthOk: true, healthStatus: 'busy', healthLabel: 'Running' });
	});
	it('a stale bridge (> HEARTBEAT_STALE_MS) is offline even if the last beat said the server was fine', () => {
		const f = heartbeatFields({ ...base, status: 'offline', label: 'Offline', bridgeOnline: false, lastBeatMsAgo: 120_000 });
		expect(f.lastHealthOk).toBe(false);
		expect(f.healthStatus).toBe('offline');
	});
	it('no heartbeat ever → offline with null time', () => {
		expect(heartbeatFields(undefined)).toMatchObject({ lastHealthOk: false, lastHealthAt: null, healthStatus: 'offline' });
	});
});

describe('computeHealth — a restart in flight reads "Restarting", not "Engine hung" (B14 2026-11-03)', () => {
	const meta = (engine: any, health: any = { name: 'x' }) => ({ health, engine });

	it('a 1.6.0 daemon reports the restart in its heartbeat → busy / Restarting, with the start time', () => {
		const h = computeHealth(meta({ engineOk: false, restarting: { since: '2026-11-03T18:34:11Z', secondsAgo: 40 } }, null), 1000);
		expect(h.status).toBe('busy');
		expect(h.label).toBe('Restarting');
		expect(h.detail).toContain('40s ago');
		expect(h.restartingSince).toBeTruthy();
	});

	it('an older daemon: a Recover issued inside the window counts only while the engine is not answering', () => {
		expect(computeHealth(meta({ engineOk: false }, null), 1000, 90_000).label).toBe('Restarting');
		expect(computeHealth(meta({ engineOk: true }), 1000, 90_000).label).toBe('Ready'); // back → Ready wins
		expect(computeHealth(meta({ engineOk: false }, null), 1000, null).label).toBe('Engine hung');
		expect(computeHealth(meta({ engineOk: false }, null), 1000, null).restartingSince).toBeNull();
	});

	it('a stale bridge is still Offline even with a restart in flight', () => {
		expect(computeHealth(meta({ engineOk: false, restarting: { secondsAgo: 10 } }, null), 120_000).status).toBe('offline');
	});

	it('recentRestartAgeMs: inside the window unless the command expired or the daemon refused it', () => {
		const now = Date.now();
		const at = new Date(now - 60_000);
		expect(recentRestartAgeMs({ createdAt: at, status: 'claimed' }, now)).toBe(60_000);
		expect(recentRestartAgeMs({ createdAt: at, status: 'failed' }, now)).toBe(60_000); // an old daemon's false "did not come back"
		expect(recentRestartAgeMs({ createdAt: at, status: 'completed', result: { body: { restarted: false, alreadyStarting: true } } }, now)).toBe(60_000);
		expect(recentRestartAgeMs({ createdAt: at, status: 'completed', result: { body: { restarted: false, liveRun: true } } }, now)).toBeNull();
		expect(recentRestartAgeMs({ createdAt: at, status: 'expired' }, now)).toBeNull();
		expect(recentRestartAgeMs({ createdAt: new Date(now - RESTART_WINDOW_MS - 1), status: 'claimed' }, now)).toBeNull();
		expect(recentRestartAgeMs(null, now)).toBeNull();
	});
});
