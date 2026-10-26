/**
 * OT2-LOG-1 L2a: a daemon heartbeat with metadata.link becomes ONE
 * robot_link_samples row per minute, not one per 10 s heartbeat; a heartbeat
 * without `link` (older daemon) writes nothing; a sampling failure never
 * surfaces to the heartbeat route. Models are mocked; no DB.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const db = { last: null as { at: Date } | null, created: [] as any[], failCreate: false, findOneCalls: 0 };

vi.mock('$lib/server/db', () => ({
	connectDB: async () => {},
	generateId: () => 'gen',
	RobotLinkSample: {
		findOne: () => {
			db.findOneCalls++;
			const c: any = { sort: () => c, select: () => c, lean: async () => db.last };
			return c;
		},
		create: async (doc: any) => {
			if (db.failCreate) throw new Error('atlas down');
			db.created.push(doc);
			return doc;
		}
	}
}));
vi.mock('./resolve-robot', () => ({ robotIdForDevice: async (d: string) => (d === 'ot2-b14-bridge' ? 'robot-b14' : null) }));

import { daemonSampleFromHeartbeat, sampleHeartbeatLink, SAMPLE_MIN_GAP_MS } from './heartbeat-sample';

const NOW = new Date('2026-10-26T12:00:00.000Z');
const LINK = {
	iface: { default: 'eth0', eth0: { carrier: true, ip: '192.168.1.14' }, wlan0: { ip: '192.168.1.15', rssi: -61, freq: 2437 } },
	tailscale: { direct: false, relay: 'dfw', curAddr: '100.64.0.5:41641', handshakeAgeS: 12.5 },
	bims: { pollRttMs: 240, pollErrors: 0, hbErrors: 1 },
	worker: { busyAgeS: 0, queueDepth: 0 },
	daemon: { version: 'ot2-bridge 1.9', sha256: 'abc', uptimeS: 3600, journalBacklog: 2 }
};
const META = { health: { status: 'ok' }, engine: { engineOk: true }, version: 'ot2-bridge 1.9', link: LINK };

beforeEach(() => {
	db.last = null;
	db.created.length = 0;
	db.failCreate = false;
	db.findOneCalls = 0;
	vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('daemonSampleFromHeartbeat', () => {
	it('copies the link blocks, derives server from health/engine, stamps the heartbeat age', () => {
		const doc = daemonSampleFromHeartbeat({
			deviceId: 'ot2-b14-bridge',
			robotId: 'robot-b14',
			metadata: META,
			now: NOW,
			prevReceivedAt: new Date(NOW.getTime() - 10_400)
		});
		expect(doc).toMatchObject({
			robotId: 'robot-b14',
			deviceId: 'ot2-b14-bridge',
			at: NOW,
			source: 'daemon',
			iface: { default: 'eth0', eth0: { carrier: true, ip: '192.168.1.14' }, wlan0: { ip: '192.168.1.15', rssi: -61, freq: 2437 } },
			tailscale: { direct: false, relay: 'dfw', curAddr: '100.64.0.5:41641', handshakeAgeS: 12.5 },
			bims: { pollRttMs: 240, pollErrors: 0, hbErrors: 1, hbAgeAtReceiptMs: 10_400 },
			worker: { busyAgeS: 0, queueDepth: 0 },
			daemon: { version: 'ot2-bridge 1.9', sha256: 'abc', uptimeS: 3600, journalBacklog: 2 },
			server: { healthOk: true, engineOk: true }
		});
	});
	it('a hung engine and a dead server read false, like health.ts; missing engine block is engineOk', () => {
		const hung = daemonSampleFromHeartbeat({ deviceId: 'd', robotId: null, metadata: { health: null, engine: { engineOk: false }, link: {} }, now: NOW, prevReceivedAt: null });
		expect(hung.server).toEqual({ healthOk: false, engineOk: false });
		const old = daemonSampleFromHeartbeat({ deviceId: 'd', robotId: null, metadata: { health: {}, link: {} }, now: NOW, prevReceivedAt: null });
		expect(old.server).toEqual({ healthOk: true, engineOk: true });
		expect((old.bims as any).hbAgeAtReceiptMs).toBeUndefined();
	});
	it('a dev box without NetworkManager sends nulls — fields come through null/undefined, never throw', () => {
		const doc = daemonSampleFromHeartbeat({
			deviceId: 'd',
			robotId: null,
			metadata: { link: { iface: { default: null, eth0: null, wlan0: null }, tailscale: { direct: null, relay: null }, bims: null, daemon: { version: null } }, version: 'v9' },
			now: NOW,
			prevReceivedAt: null
		});
		expect(doc.iface).toEqual({ default: null, eth0: undefined, wlan0: undefined });
		expect(doc.tailscale).toEqual({ direct: undefined, relay: null, curAddr: null, handshakeAgeS: null });
		expect((doc.daemon as any).version).toBe('v9'); // falls back to metadata.version
	});
	it('wrong-typed values are dropped rather than cast', () => {
		const doc = daemonSampleFromHeartbeat({
			deviceId: 'd',
			robotId: null,
			metadata: { link: { bims: { pollRttMs: '240' }, worker: { busyAgeS: 'x', queueDepth: 3 } } },
			now: NOW,
			prevReceivedAt: null
		});
		expect((doc.bims as any).pollRttMs).toBeUndefined();
		expect(doc.worker).toEqual({ busyAgeS: undefined, queueDepth: 3 });
	});
});

describe('sampleHeartbeatLink', () => {
	const beat = (overrides: Partial<Parameters<typeof sampleHeartbeatLink>[0]> = {}) =>
		sampleHeartbeatLink({ deviceId: 'ot2-b14-bridge', metadata: META, now: NOW, prevReceivedAt: new Date(NOW.getTime() - 10_000), ...overrides });

	it('first heartbeat with link → sampled, robot resolved from the device', async () => {
		await expect(beat()).resolves.toEqual({ sampled: true, ageMs: 10_000 });
		expect(db.created).toHaveLength(1);
		expect(db.created[0]).toMatchObject({ robotId: 'robot-b14', deviceId: 'ot2-b14-bridge', source: 'daemon' });
	});
	it('a sample younger than 55 s → not sampled, no write, one indexed read', async () => {
		db.last = { at: new Date(NOW.getTime() - (SAMPLE_MIN_GAP_MS - 1000)) };
		await expect(beat()).resolves.toEqual({ sampled: false, ageMs: 10_000 });
		expect(db.created).toHaveLength(0);
		expect(db.findOneCalls).toBe(1);
	});
	it('a sample exactly 55 s old → sampled again (≤ 1/min, ten heartbeats → one sample)', async () => {
		db.last = { at: new Date(NOW.getTime() - SAMPLE_MIN_GAP_MS) };
		await expect(beat()).resolves.toMatchObject({ sampled: true });
		expect(db.created).toHaveLength(1);
	});
	it('no link block (older daemon) → nothing read or written, age still reported', async () => {
		await expect(beat({ metadata: { health: {}, engine: {} } })).resolves.toEqual({ sampled: false, ageMs: 10_000 });
		expect(db.findOneCalls).toBe(0);
		expect(db.created).toHaveLength(0);
	});
	it('an unmapped device still stores the sample with robotId null', async () => {
		await expect(beat({ deviceId: 'ot2-zz9-bridge' })).resolves.toMatchObject({ sampled: true });
		expect(db.created[0].robotId).toBeNull();
	});
	it('a write failure is swallowed (warned) — the heartbeat must not fail', async () => {
		db.failCreate = true;
		await expect(beat()).resolves.toEqual({ sampled: false, ageMs: 10_000 });
		expect(console.warn).toHaveBeenCalled();
	});
	it('first heartbeat ever → ageMs null', async () => {
		await expect(beat({ prevReceivedAt: null })).resolves.toEqual({ sampled: true, ageMs: null });
	});
});
