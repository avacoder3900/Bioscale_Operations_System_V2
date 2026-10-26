/**
 * OT2-LOG-1 L2b: POST /api/agent/robot-link/samples — agent key, ≤ 500 rows,
 * per-row validation with {index, reason} rejections, robotId resolved from
 * deviceId when absent, insertMany ordered:false. Models are mocked; no DB.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const db = { inserted: [] as any[], failWith: null as null | any };

vi.mock('$lib/server/api-auth', () => ({
	requireAgentApiKey: (req: Request) => {
		if (req.headers.get('x-agent-api-key') !== 'k') throw Object.assign(new Error('Unauthorized'), { status: 401 });
	}
}));
vi.mock('$lib/server/db', () => ({
	connectDB: async () => {},
	generateId: () => 'gen',
	RobotLinkSample: {
		insertMany: async (docs: any[], opts: any) => {
			expect(opts).toEqual({ ordered: false });
			if (db.failWith) throw db.failWith;
			db.inserted.push(...docs);
			return docs;
		}
	}
}));
vi.mock('$lib/server/services/robot-link/resolve-robot', () => ({
	robotIdForDevice: async (d: string) => (d === 'ot2-b14-bridge' ? 'robot-b14' : null)
}));

import { POST } from './+server';

const NOW = new Date('2026-10-26T12:00:00.000Z');
const AT = NOW.toISOString();
const PATH = { name: 'wired', ip: '192.168.1.14', lossPct: 0, rttMs: 1.2, healthMs: 35, healthErr: null };

function post(body: unknown, key = 'k') {
	return (POST as any)({
		request: new Request('https://bims.example/api/agent/robot-link/samples', {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-agent-api-key': key },
			body: typeof body === 'string' ? body : JSON.stringify(body)
		})
	}) as Promise<Response>;
}
const status = (p: Promise<Response>) => p.then((r) => r.status).catch((e) => e.status);

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	db.inserted.length = 0;
	db.failWith = null;
});
afterEach(() => vi.useRealTimers());

describe('POST /api/agent/robot-link/samples', () => {
	it('rejects a bad key, bad JSON, a non-array and > 500 rows', async () => {
		expect(await status(post({ samples: [] }, 'wrong'))).toBe(401);
		expect(await status(post('{nope'))).toBe(400);
		expect(await status(post({ samples: 'x' }))).toBe(400);
		expect(await status(post({ samples: Array.from({ length: 501 }, () => ({})) }))).toBe(400);
		expect(db.inserted).toHaveLength(0);
	});

	it('inserts valid rows, resolving robotId from deviceId when absent', async () => {
		const res = await post({
			samples: [
				{ robotId: 'robot-x', at: AT, source: 'imac', paths: [PATH, { ...PATH, name: 'wifi', lossPct: 12.5, rttMs: null, healthMs: null, healthErr: 'timeout' }] },
				{ deviceId: 'ot2-b14-bridge', at: AT, source: 'imac', paths: [{ ...PATH, name: 'tailnet' }] },
				{ deviceId: 'ot2-zz9-bridge', at: AT, source: 'daemon', paths: [PATH] }
			]
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ inserted: 3, rejected: [] });
		expect(db.inserted).toHaveLength(3);
		expect(db.inserted[0]).toMatchObject({ _id: 'gen', robotId: 'robot-x', at: NOW, source: 'imac' });
		expect(db.inserted[0].paths).toEqual([PATH, { ...PATH, name: 'wifi', lossPct: 12.5, rttMs: null, healthMs: null, healthErr: 'timeout' }]);
		expect(db.inserted[1]).toMatchObject({ robotId: 'robot-b14', deviceId: 'ot2-b14-bridge' });
		expect(db.inserted[2]).toMatchObject({ robotId: null, deviceId: 'ot2-zz9-bridge', source: 'daemon' });
	});

	it('reports each bad row by index with a reason and still inserts the good ones', async () => {
		const good = { robotId: 'r', at: AT, source: 'imac', paths: [PATH] };
		const res = await post({
			samples: [
				good,
				{ at: AT, source: 'imac', paths: [PATH] }, // 1: no robot/device
				{ robotId: 'r', at: 'not-a-date', source: 'imac', paths: [PATH] }, // 2
				{ robotId: 'r', at: new Date(NOW.getTime() - 2 * 86_400_000).toISOString(), source: 'imac', paths: [PATH] }, // 3: too old
				{ robotId: 'r', at: AT, source: 'browser', paths: [PATH] }, // 4
				{ robotId: 'r', at: AT, source: 'imac', paths: [] }, // 5
				{ robotId: 'r', at: AT, source: 'imac', paths: [{ ...PATH, name: 'usb' }] }, // 6
				{ robotId: 'r', at: AT, source: 'imac', paths: [{ ...PATH, lossPct: 101 }] }, // 7
				{ robotId: 'r', at: AT, source: 'imac', paths: [{ ...PATH, rttMs: 'fast' }] }, // 8
				{ robotId: 'r', at: AT, source: 'imac', paths: [{ ...PATH, ip: 5 }] }, // 9
				'nope', // 10
				good
			]
		});
		expect(res.status).toBe(200);
		const out = await res.json();
		expect(out.inserted).toBe(2);
		expect(out.rejected.map((r: any) => r.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
		expect(out.rejected[0].reason).toMatch(/robotId or deviceId/);
		expect(out.rejected[2].reason).toMatch(/within 1 day/);
		expect(out.rejected[3].reason).toMatch(/source/);
		expect(out.rejected[6].reason).toMatch(/lossPct/);
		expect(db.inserted).toHaveLength(2);
	});

	it('accepts absent optional metrics as null and a time just inside ±1 day', async () => {
		const res = await post({
			samples: [{ robotId: 'r', at: new Date(NOW.getTime() + 86_000_000).toISOString(), source: 'imac', paths: [{ name: 'wifi', ip: '10.0.0.2' }] }]
		});
		expect(await res.json()).toEqual({ inserted: 1, rejected: [] });
		expect(db.inserted[0].paths[0]).toEqual({ name: 'wifi', ip: '10.0.0.2', lossPct: null, rttMs: null, healthMs: null, healthErr: null });
	});

	it('an empty batch is a no-op', async () => {
		expect(await (await post({ samples: [] })).json()).toEqual({ inserted: 0, rejected: [] });
	});

	it('a partial bulk-write failure reports the refused rows against their original index', async () => {
		db.failWith = Object.assign(new Error('bulk'), { writeErrors: [{ index: 1, errmsg: 'dup' }], insertedDocs: [{}] });
		const res = await post({
			samples: [
				{ robotId: 'r', at: AT, source: 'imac', paths: [PATH] },
				{ at: AT, source: 'imac', paths: [PATH] }, // rejected by validation → docs[1] is the third row
				{ robotId: 'r', at: AT, source: 'imac', paths: [PATH] }
			]
		});
		expect(await res.json()).toEqual({ inserted: 1, rejected: [{ index: 1, reason: 'robotId or deviceId is required' }, { index: 2, reason: 'dup' }] });
	});
});
