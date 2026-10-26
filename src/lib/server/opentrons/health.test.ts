/**
 * heartbeatFields(): the legacy robot pages' lastHealthOk/lastHealthAt now come
 * from the daemon heartbeat (health.ts), not the dead OpentronsRobot fields.
 */
import { describe, it, expect } from 'vitest';
import { heartbeatFields, type RobotHealth } from './health';

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
