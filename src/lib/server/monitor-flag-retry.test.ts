import { describe, it, expect } from 'vitest';
import { monitorFlagNeedsPush } from './monitor-flag-retry';

const now = new Date('2026-11-16T18:00:00Z');
const link = (extra: Record<string, unknown> = {}) => ({ particleDeviceId: 'dev1', ...extra });
const on = { enabled: true, enabledAt: '2026-10-19T21:17:58Z' };

describe('monitorFlagNeedsPush', () => {
	it('retries a push that timed out mid-test (state offline) when the test upload arrives', () => {
		const spu = { monitoring: on, particleLink: link({ monitorFlag: null, monitorFlagState: 'offline', monitorFlagSyncedAt: '2026-10-19T21:18:14Z' }) };
		expect(monitorFlagNeedsPush(spu, 'upload-test', now)).toBe(true);
	});

	it('pushes once for an enabled unit BIMS has no sync record for', () => {
		expect(monitorFlagNeedsPush({ monitoring: on, particleLink: link() }, 'device-log', now)).toBe(true);
	});

	it('leaves a synced unit alone', () => {
		const spu = { monitoring: on, particleLink: link({ monitorFlag: 1, monitorFlagState: 'synced' }) };
		expect(monitorFlagNeedsPush(spu, 'upload-test', now)).toBe(false);
	});

	it('pushes the clear when monitoring was turned off but the device still has 1', () => {
		const spu = { monitoring: { enabled: false, enabledAt: on.enabledAt, disabledAt: '2026-11-15T00:00:00Z' }, particleLink: link({ monitorFlag: 1, monitorFlagState: 'synced' }) };
		expect(monitorFlagNeedsPush(spu, 'upload-test', now)).toBe(true);
	});

	it('never touches a unit that was never configured for monitoring', () => {
		expect(monitorFlagNeedsPush({ monitoring: { enabled: false }, particleLink: link() }, 'upload-test', now)).toBe(false);
		expect(monitorFlagNeedsPush({ particleLink: link() }, 'upload-test', now)).toBe(false);
	});

	it('ignores events that do not mean "connected and staying connected"', () => {
		const spu = { monitoring: on, particleLink: link({ monitorFlagState: 'offline' }) };
		// validate-cartridge: the device disconnects for the test right after the reply
		expect(monitorFlagNeedsPush(spu, 'validate-cartridge', now)).toBe(false);
	});

	it('does not call the device twice within a minute', () => {
		const spu = { monitoring: on, particleLink: link({ monitorFlagState: 'offline', monitorFlagSyncedAt: '2026-11-16T17:59:30Z' }) };
		expect(monitorFlagNeedsPush(spu, 'device-log', now)).toBe(false);
	});

	it('skips unsupported firmware and unlinked units', () => {
		expect(monitorFlagNeedsPush({ monitoring: on, particleLink: link({ monitorFlagState: 'unsupported' }) }, 'upload-test', now)).toBe(false);
		expect(monitorFlagNeedsPush({ monitoring: on, particleLink: {} }, 'upload-test', now)).toBe(false);
	});
});
