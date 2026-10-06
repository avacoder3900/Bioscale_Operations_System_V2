import { describe, expect, it, vi } from 'vitest';
import { BridgeError, createBridgeClient, type RobotFetch } from './bridge-client';

const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function harness(opts: { robot?: (path: string, init: any, auth: string | undefined) => Response | Promise<Response> } = {}) {
	let now = 1_800_000_000_000; // ms
	let minted = 0;
	const bimsFetch = vi.fn(async (url: string) => {
		minted++;
		expect(url).toBe('/api/opentrons-lab/robots/robot-1/bridge-token?kinds=sweep%2Cscan');
		return json(200, { token: `tok-${minted}`, exp: Math.floor(now / 1000) + 300 });
	});
	const calls: Array<{ path: string; method: string; auth?: string; body?: any }> = [];
	const robotFetch: RobotFetch = vi.fn(async (path, init: any = {}) => {
		const auth = init.headers?.authorization as string | undefined;
		calls.push({ path, method: init.method, auth, body: init.body ? JSON.parse(init.body) : undefined });
		return opts.robot ? opts.robot(path, init, auth) : json(200, { ok: true });
	});
	const client = createBridgeClient({
		robotId: 'robot-1',
		robotFetch,
		bimsFetch,
		kinds: ['sweep', 'scan'],
		nowMs: () => now,
		sleep: async () => {}
	});
	return { client, bimsFetch, robotFetch, calls, advance: (ms: number) => (now += ms), minted: () => minted };
}

describe('token lifecycle', () => {
	it('fetches once, reuses, refreshes before exp', async () => {
		const h = harness();
		expect(await h.client.token()).toBe('tok-1');
		expect(await h.client.token()).toBe('tok-1');
		h.advance(230_000); // 70 s before exp: still fine
		expect(await h.client.token()).toBe('tok-1');
		h.advance(15_000); // 55 s before exp: inside the 60 s margin → refresh
		expect(await h.client.token()).toBe('tok-2');
		expect(h.bimsFetch).toHaveBeenCalledTimes(2);
	});

	it('coalesces concurrent token fetches', async () => {
		const h = harness();
		await Promise.all([h.client.token(), h.client.token(), h.client.token()]);
		expect(h.bimsFetch).toHaveBeenCalledTimes(1);
	});

	it('BIMS 409 (robot not on the tailnet here) → not_tailnet', async () => {
		const client = createBridgeClient({
			robotId: 'r',
			robotFetch: async () => json(200, {}),
			bimsFetch: async () => json(409, { error: 'queue — robot not switched to tailnet' })
		});
		await expect(client.health()).rejects.toMatchObject({ code: 'not_tailnet', status: 409 });
	});
});

describe('submitJob', () => {
	it('POSTs {kind, payload, jobId} with the bearer token', async () => {
		const h = harness({ robot: () => json(202, { jobId: 'j-123456', status: 'queued', position: 1, duplicate: false }) });
		const r = await h.client.submit({ kind: 'sweep', payload: { sweepRunId: 's1' }, jobId: 'j-123456' });
		expect(r).toEqual({ jobId: 'j-123456', status: 'queued', position: 1, duplicate: false });
		expect(h.calls).toEqual([
			{ path: '/bridge/jobs', method: 'POST', auth: 'Bearer tok-1', body: { kind: 'sweep', payload: { sweepRunId: 's1' }, jobId: 'j-123456' } }
		]);
	});

	it('is never retried: not on a network error…', async () => {
		const h = harness({
			robot: () => {
				throw new TypeError('Failed to fetch');
			}
		});
		await expect(h.client.submitJob('sweep', {})).rejects.toMatchObject({ code: 'network' });
		expect(h.calls).toHaveLength(1);
	});

	it('…and not on a 401 — but the next call mints a fresh token', async () => {
		let n = 0;
		const h = harness({ robot: () => (n++ === 0 ? json(401, { error: 'token expired', service: 'ot2-bridge' }) : json(200, { ok: true, service: 'ot2-bridge' })) });
		const err = await h.client.submitJob('sweep', {}).catch((e) => e);
		expect(err).toBeInstanceOf(BridgeError);
		expect(err).toMatchObject({ code: 'unauthorized', status: 401, message: 'token expired' });
		expect(h.calls).toHaveLength(1);
		await h.client.health();
		expect(h.calls[1].auth).toBe('Bearer tok-2');
	});

	it('403 scope → forbidden', async () => {
		const h = harness({ robot: () => json(403, { error: "token does not allow 'sweep'" }) });
		await expect(h.client.submitJob('sweep', {})).rejects.toMatchObject({ code: 'forbidden' });
	});
});

describe('reads retry a 401 once with a fresh token', () => {
	it('getJob', async () => {
		const h = harness({
			robot: (_p, _i, auth) =>
				auth === 'Bearer tok-1' ? json(401, { error: 'bad token signature' }) : json(200, { jobId: 'j', status: 'running' })
		});
		const job = await h.client.getJob('j');
		expect(job.status).toBe('running');
		expect(h.calls.map((c) => c.auth)).toEqual(['Bearer tok-1', 'Bearer tok-2']);
	});

	it('a second 401 surfaces', async () => {
		const h = harness({ robot: () => json(401, { error: 'bad token signature' }) });
		await expect(h.client.getJob('j')).rejects.toMatchObject({ code: 'unauthorized' });
		expect(h.calls).toHaveLength(2);
	});
});

describe('pollJob', () => {
	it('reports each snapshot and resolves on a terminal status', async () => {
		const seq = ['queued', 'running', 'running', 'completed'];
		let i = 0;
		const h = harness({
			robot: (path) => {
				expect(path).toBe('/bridge/jobs/job-abcdef');
				return json(200, { jobId: 'job-abcdef', status: seq[i++], progress: { slotsDone: i } });
			}
		});
		const seen: string[] = [];
		const final = await h.client.pollJob('job-abcdef', (j) => seen.push(j.status));
		expect(final.status).toBe('completed');
		expect(seen).toEqual(seq);
	});

	it('tolerates a few dropped polls, then gives up', async () => {
		let i = 0;
		const h = harness({
			robot: () => {
				i++;
				if (i === 1 || i === 2) throw new TypeError('Failed to fetch');
				return json(200, { jobId: 'j', status: 'failed', error: 'x' });
			}
		});
		expect((await h.client.pollJob('j')).status).toBe('failed');

		const dead = harness({
			robot: () => {
				throw new TypeError('Failed to fetch');
			}
		});
		await expect(dead.client.pollJob('j', undefined, { maxMisses: 2 })).rejects.toMatchObject({ code: 'network' });
		expect(dead.calls).toHaveLength(3);
	});

	it('a 404 (unknown job) is not swallowed', async () => {
		const h = harness({ robot: () => json(404, { error: 'unknown job' }) });
		await expect(h.client.pollJob('j')).rejects.toMatchObject({ code: 'not_found' });
	});
});

describe('control, testScan, health, probe', () => {
	it('control posts the action', async () => {
		const h = harness({ robot: () => json(200, { jobId: 'j', status: 'running', pauseRequested: true }) });
		await h.client.control('j', 'pause');
		expect(h.calls[0]).toMatchObject({ path: '/bridge/jobs/j/control', method: 'POST', body: { action: 'pause' } });
	});

	it('control 409 → conflict', async () => {
		const h = harness({ robot: () => json(409, { error: 'a running deck_scan cannot be interrupted' }) });
		await expect(h.client.control('j', 'cancel')).rejects.toMatchObject({ code: 'conflict' });
	});

	it('testScan posts to /bridge/scan once', async () => {
		const h = harness({ robot: () => json(200, { scanId: 's', barcode: 'CART-1', rawPayload: null, error: null, eventPosted: true }) });
		expect((await h.client.testScan({ source: 'test' })).barcode).toBe('CART-1');
		expect(h.calls).toEqual([{ path: '/bridge/scan', method: 'POST', auth: 'Bearer tok-1', body: { source: 'test' } }]);
	});

	it('health returns body + latency', async () => {
		const h = harness({ robot: () => json(200, { ok: true, service: 'ot2-bridge', version: 'ot2-bridge/1.1' }) });
		const r = await h.client.health();
		expect(r.body.version).toBe('ot2-bridge/1.1');
		expect(typeof r.latencyMs).toBe('number');
	});

	it('probe classifies without a token', async () => {
		const probe = async (res: Response | Error) =>
			createBridgeClient({
				robotId: 'r',
				robotFetch: async (_p, init: any) => {
					expect(init?.headers?.authorization).toBeUndefined();
					if (res instanceof Error) throw res;
					return res;
				},
				bimsFetch: async () => {
					throw new Error('probe must not mint a token');
				}
			}).probe();
		expect(await probe(json(401, { error: 'missing bearer token', service: 'ot2-bridge' }))).toMatchObject({ served: true, state: 'auth-required' });
		expect(await probe(json(503, { error: 'disabled', service: 'ot2-bridge' }))).toMatchObject({ served: true, state: 'disabled' });
		expect(await probe(json(404, { detail: 'Not Found' }))).toMatchObject({ served: false, state: 'not-served' });
		expect(await probe(new TypeError('Failed to fetch'))).toMatchObject({ served: null, state: 'unreachable' });
	});
});
