/**
 * The browser session's line rules (OT2-TAILNET-4):
 *   - one decision per page, visible, never silently mixed
 *   - no answer on the direct line → queue for the rest of the page (+ one retry
 *     through BIMS, except a relative jog, which must not run twice)
 *   - a queue session never talks to anything but BIMS (B07/R04 invariant)
 *   - motion defers to the queue while a daemon job holds the gantry
 */
import { describe, it, expect } from 'vitest';
import { RobotSession, routeToVerb, noRetryLabel } from './direct-client';

const DIRECT = 'https://ot2-b14.tailf65a70.ts.net';
const res = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

function fakeFetch(handler: Handler) {
	const urls: string[] = [];
	const f = (async (input: any, init?: any) => {
		const url = String(input);
		urls.push(url);
		return handler(url, init);
	}) as typeof fetch;
	return { f, urls };
}

const connTailnet = (busy: unknown = null) => res(200, { transport: 'tailnet', directUrl: DIRECT, reason: 'tailnet', busy });
const opts = { refreshMs: 0, flushMs: 0, permissionQuery: async () => 'granted' as const };

describe('opening the session', () => {
	it('tailnet + reachable robot → direct', async () => {
		const { f } = fakeFetch((url) => (url.endsWith('/connection') ? connTailnet() : res(200, { name: 'B14' })));
		const s = new RobotSession('b14', { ...opts, fetchImpl: f });
		await s.open();
		expect(s.state.transport).toBe('direct');
	});

	it('tailnet but this computer cannot reach it → queue, with the reason', async () => {
		const { f } = fakeFetch((url) => {
			if (url.endsWith('/connection')) return connTailnet();
			throw new TypeError('Failed to fetch');
		});
		const s = new RobotSession('b14', { ...opts, fetchImpl: f });
		await s.open();
		expect(s.state.transport).toBe('queue');
		expect(s.state.reason).toContain("can't reach");
	});

	it('/connection unavailable → queue (any doubt means queue)', async () => {
		const { f } = fakeFetch(() => res(500, {}));
		const s = new RobotSession('b14', { ...opts, fetchImpl: f });
		await s.open();
		expect(s.state.transport).toBe('queue');
	});
});

describe('queue sessions (B07 / R04 today)', () => {
	it('never fetch anything but same-origin BIMS routes', async () => {
		const { f, urls } = fakeFetch((url) =>
			url.endsWith('/connection') ? res(200, { transport: 'queue', reason: 'queue', busy: null }) : res(200, { data: { status: 'running' } })
		);
		const s = new RobotSession('b07', { ...opts, fetchImpl: f });
		await s.open();
		await s.call('run.get', { rid: 'r1' });
		await s.call('run.action', { rid: 'r1', action: 'pause' });
		await s.call('mx.jog', { runId: 'm1', pipetteId: 'p', axis: 'x', distance: 1 });
		expect(urls.every((u) => u.startsWith('/api/opentrons-lab/robots/b07/'))).toBe(true);
		expect(urls).toContain('/api/opentrons-lab/robots/b07/runs/r1/actions');
		expect(urls).toContain('/api/opentrons-lab/robots/b07/maintenance/m1/jog');
	});
});

describe('direct sessions', () => {
	async function directSession(robotHandler: Handler, busy: unknown = null) {
		const ff = fakeFetch((url, init) => {
			if (url.endsWith('/connection')) return connTailnet(busy);
			if (url === `${DIRECT}/health`) return res(200, { name: 'B14' });
			if (url.startsWith('/api/')) return res(200, { via: 'queue', url });
			return robotHandler(url, init);
		});
		const s = new RobotSession('b14', { ...opts, fetchImpl: ff.f });
		await s.open();
		return { s, urls: ff.urls };
	}

	it('calls the robot directly and returns the route-shaped body', async () => {
		const { s, urls } = await directSession(() => res(201, {}));
		const r = await s.call('run.action', { rid: 'r1', action: 'pause' });
		expect(urls).toContain(`${DIRECT}/runs/r1/actions`);
		expect(r.status).toBe(200);
		expect(await r.json()).toEqual({ ok: true, action: 'pause' });
	});

	it('a robot 4xx is an answer, not a line failure — stays direct', async () => {
		const { s } = await directSession(() => res(409, { errors: [{ detail: 'already paused' }] }));
		const r = await s.call('run.action', { rid: 'r1', action: 'pause' });
		expect(r.status).toBe(409);
		expect(s.state.transport).toBe('direct');
	});

	it('no answer → falls back to queue for the rest of the page and retries once via BIMS', async () => {
		const { s, urls } = await directSession(() => {
			throw new TypeError('Failed to fetch');
		});
		const r = await s.call('run.action', { rid: 'r1', action: 'pause' });
		expect(s.state.transport).toBe('queue');
		expect(s.state.fellBack).toBe(true);
		expect(await r.json()).toMatchObject({ via: 'queue' });
		expect(urls.filter((u) => u.startsWith('/api/') && u.endsWith('/runs/r1/actions'))).toHaveLength(1);
		// Sticky: the next call goes straight to the queue, no direct attempt.
		const before = urls.length;
		await s.call('run.get', { rid: 'r1' });
		expect(urls.slice(before).every((u) => u.startsWith('/api/'))).toBe(true);
	});

	it('a relative jog that lost its answer is NOT retried (it may have moved)', async () => {
		const { s, urls } = await directSession(() => {
			throw new TypeError('Failed to fetch');
		});
		const r = await s.call('mx.jog', { runId: 'm1', pipetteId: 'p', axis: 'x', distance: 1 });
		expect(r.status).toBe(502);
		expect(urls.some((u) => u.startsWith('/api/') && u.endsWith('/jog'))).toBe(false);
		expect(s.state.transport).toBe('queue');
	});

	it("the caller's own timeout surfaces as the caller's error and does not fall back", async () => {
		const { s } = await directSession((_u, init) => {
			return new Promise((_, reject) => {
				init?.signal?.addEventListener('abort', () => reject(new DOMException('timed out', 'TimeoutError')));
			});
		});
		const ac = new AbortController();
		const p = s.call('run.get', { rid: 'r1' }, { signal: ac.signal });
		ac.abort(new DOMException('timed out', 'TimeoutError'));
		await expect(p).rejects.toMatchObject({ name: 'TimeoutError' });
		expect(s.state.transport).toBe('direct');
	});

	it('motion defers to the queue while a daemon job holds the gantry; run control stays direct', async () => {
		const { s, urls } = await directSession(() => res(201, { data: { status: 'succeeded' } }), { kind: 'sweep', since: 'now' });
		await s.call('mx.moveTo', { runId: 'm1', pipetteId: 'p', x: 1, y: 2, z: 3 });
		expect(urls).toContain('/api/opentrons-lab/robots/b14/maintenance/m1/move-to');
		await s.call('run.get', { rid: 'r1' });
		expect(urls).toContain(`${DIRECT}/runs/r1`);
	});

	it('logs every direct robot call for /direct-calls', async () => {
		const posted: any[] = [];
		const ff = fakeFetch((url, init) => {
			if (url.endsWith('/connection')) return connTailnet();
			if (url === `${DIRECT}/health`) return res(200, {});
			if (url.endsWith('/direct-calls')) {
				posted.push(JSON.parse(String(init?.body)));
				return res(200, {});
			}
			return res(201, {});
		});
		const s = new RobotSession('b14', { ...opts, fetchImpl: ff.f });
		await s.open();
		await s.call('run.action', { rid: 'r1', action: 'play' });
		await s.flush();
		expect(posted[0].calls).toHaveLength(1);
		expect(posted[0].calls[0]).toMatchObject({ verb: 'run.action', method: 'POST', path: '/runs/r1/actions', status: 201, ok: true });
	});
});

describe('fetchRoute (pages that already call BIMS routes)', () => {
	it('maps the maintenance routes to verbs; anything else stays a plain BIMS fetch', () => {
		expect(routeToVerb('/api/opentrons-lab/robots/b14/maintenance/m1/jog', 'POST')).toEqual({ robotId: 'b14', runId: 'm1', verb: 'mx.jog' });
		expect(routeToVerb('/api/opentrons-lab/robots/b14/maintenance/m1/move-to-well', 'POST')?.verb).toBe('mx.moveToWell');
		expect(routeToVerb('/api/opentrons-lab/robots/b14/maintenance', 'POST')).toEqual({ robotId: 'b14', verb: 'mx.open' });
		expect(routeToVerb('/api/opentrons-lab/robots/b14/maintenance/m1', 'DELETE')).toEqual({ robotId: 'b14', runId: 'm1', verb: 'mx.close' });
		expect(routeToVerb('/api/opentrons-lab/robots/b14/maintenance/m1/pick-up-tip', 'POST')?.verb).toBe('mx.pickUpTip');
		expect(routeToVerb('/api/opentrons-lab/robots/b14/maintenance/m1/load-labware', 'POST')?.verb).toBe('mx.loadLabware');
		expect(routeToVerb('/api/opentrons-lab/robots/b14/runs', 'POST')).toBeNull(); // Start Run → BIMS
		expect(routeToVerb('/api/scanner/sweep', 'POST')).toBeNull();
	});

	it('jog: robot line direct', async () => {
		const ff = fakeFetch((url) => {
			if (url.endsWith('/connection')) return connTailnet();
			if (url === `${DIRECT}/health`) return res(200, {});
			if (url.startsWith('/api/')) return res(200, { via: 'bims' });
			return res(201, { data: { status: 'succeeded' } });
		});
		const s = new RobotSession('b14', { ...opts, fetchImpl: ff.f });
		await s.open();
		const jog = await s.fetchRoute('/api/opentrons-lab/robots/b14/maintenance/m1/jog', {
			method: 'POST',
			body: JSON.stringify({ pipetteId: 'p', axis: 'y', distance: 2 })
		});
		expect(await jog.json()).toEqual({ ok: true });
		expect(ff.urls).toContain(`${DIRECT}/maintenance_runs/m1/commands?waitUntilComplete=true&timeout=30000`);
	});

	it('open over the tailnet: robot half direct, AuditLog half via /direct-record', async () => {
		const records: any[] = [];
		const ff = fakeFetch((url, init) => {
			if (url.endsWith('/connection')) return connTailnet();
			if (url === `${DIRECT}/health`) return res(200, {});
			if (url === `${DIRECT}/pipettes`) return res(200, { left: { name: 'p20_single_gen2' } });
			if (url === `${DIRECT}/maintenance_runs`) return res(201, { data: { id: 'm7' } });
			if (url.endsWith('/direct-record')) {
				records.push(JSON.parse(String(init?.body)));
				return res(200, {});
			}
			if (url.startsWith(DIRECT)) return res(201, { data: { status: 'succeeded', result: { pipetteId: 'pp' } } });
			return res(500, { unexpected: url });
		});
		const s = new RobotSession('b14', { ...opts, fetchImpl: ff.f });
		await s.open();
		const r = await s.fetchRoute('/api/opentrons-lab/robots/b14/maintenance', { method: 'POST', body: JSON.stringify({ mount: 'left' }) });
		expect(await r.json()).toEqual({ runId: 'm7', pipetteId: 'pp', pipetteName: 'p20_single_gen2', mount: 'left' });
		expect(records).toEqual([{ record: { event: 'maintenance_run_open', runId: 'm7', pipetteId: 'pp', pipetteName: 'p20_single_gen2', mount: 'left' } }]);
		expect(ff.urls).not.toContain('/api/opentrons-lab/robots/b14/maintenance'); // the queue route was not used
	});

	it('pick-up-tip over the tailnet: definition from BIMS, robot direct, cursor via /direct-record', async () => {
		const DEF = { namespace: 'opentrons', version: 1 };
		const ff = fakeFetch((url) => {
			if (url.endsWith('/connection')) return res(200, { transport: 'tailnet', directUrl: DIRECT, reason: 't', busy: null, hardened: true });
			if (url === `${DIRECT}/health`) return res(200, {});
			if (url.startsWith('/api/opentrons-lab/labware/resolve?')) return res(200, { definition: DEF, labwareNamespace: 'opentrons', labwareVersion: 1 });
			if (url.endsWith('/direct-record')) return res(200, { nextTipWell: 'D1' });
			if (url === `${DIRECT}/maintenance_runs/m1`) return res(200, { data: { labware: [] } });
			if (url.endsWith('/labware_definitions')) return res(201, {});
			return res(201, { data: { status: 'succeeded', result: { labwareId: 'rack' } } });
		});
		const s = new RobotSession('b14', { ...opts, fetchImpl: ff.f });
		await s.open();
		const r = await s.fetchRoute('/api/opentrons-lab/robots/b14/maintenance/m1/pick-up-tip', {
			method: 'POST',
			body: JSON.stringify({ pipetteId: 'p', tiprackLoadName: 'opentrons_96_tiprack_20ul', slot: '11', tipWell: 'C1' })
		});
		expect(await r.json()).toEqual({ tiprackLabwareId: 'rack', nextTipWell: 'D1' });
		expect(ff.urls).toContain('/api/opentrons-lab/labware/resolve?loadName=opentrons_96_tiprack_20ul');
	});

	it('unknown labware → the resolver 404 comes back as-is, robot untouched', async () => {
		const ff = fakeFetch((url) => {
			if (url.endsWith('/connection')) return connTailnet();
			if (url === `${DIRECT}/health`) return res(200, {});
			if (url.startsWith('/api/opentrons-lab/labware/resolve?')) return res(404, { message: 'Labware definition "nope" not found' });
			return res(200, {});
		});
		const s = new RobotSession('b14', { ...opts, fetchImpl: ff.f });
		await s.open();
		const r = await s.fetchRoute('/api/opentrons-lab/robots/b14/maintenance/m1/load-labware', { method: 'POST', body: JSON.stringify({ loadName: 'nope' }) });
		expect(r.status).toBe(404);
		expect(ff.urls.some((u) => u.includes('maintenance_runs'))).toBe(false);
	});

	it('a BIMS record that fails to save never turns a robot success into a failure', async () => {
		const ff = fakeFetch((url) => {
			if (url.endsWith('/connection')) return connTailnet();
			if (url === `${DIRECT}/health`) return res(200, {});
			if (url.endsWith('/direct-record')) return res(500, {});
			return res(404, {}); // DELETE of an already-gone run is fine
		});
		const s = new RobotSession('b14', { ...opts, fetchImpl: ff.f });
		await s.open();
		const r = await s.fetchRoute('/api/opentrons-lab/robots/b14/maintenance/m1', { method: 'DELETE' });
		expect(r.status).toBe(200);
		expect((await r.json()).recordError).toContain('maintenance_run_close');
	});

	it('a tip pick-up that lost its answer is not retried', async () => {
		const ff = fakeFetch((url) => {
			if (url.endsWith('/connection')) return connTailnet();
			if (url === `${DIRECT}/health`) return res(200, {});
			if (url.startsWith('/api/opentrons-lab/labware/resolve?')) return res(200, { definition: {}, labwareNamespace: 'o', labwareVersion: 1 });
			if (url.startsWith('/api/')) return res(200, { via: 'queue' });
			throw new TypeError('Failed to fetch');
		});
		const s = new RobotSession('b14', { ...opts, fetchImpl: ff.f });
		await s.open();
		const r = await s.fetchRoute('/api/opentrons-lab/robots/b14/maintenance/m1/pick-up-tip', {
			method: 'POST',
			body: JSON.stringify({ pipetteId: 'p', tiprackLoadName: 'r' })
		});
		expect(r.status).toBe(502);
		expect(ff.urls).not.toContain('/api/opentrons-lab/robots/b14/maintenance/m1/pick-up-tip');
		expect(s.state.transport).toBe('queue');
	});

	it("another robot's route is never served by this session's line", async () => {
		const ff = fakeFetch((url) => {
			if (url.endsWith('/connection')) return connTailnet();
			if (url === `${DIRECT}/health`) return res(200, {});
			return res(200, { via: 'bims' });
		});
		const s = new RobotSession('b14', { ...opts, fetchImpl: ff.f });
		await s.open();
		await s.fetchRoute('/api/opentrons-lab/robots/b07/maintenance/m1/jog', { method: 'POST', body: JSON.stringify({ pipetteId: 'p', axis: 'x', distance: 1 }) });
		expect(ff.urls).toContain('/api/opentrons-lab/robots/b07/maintenance/m1/jog');
		expect(ff.urls.some((u) => u.startsWith(DIRECT) && u.includes('maintenance_runs'))).toBe(false);
	});
});

describe("Chrome's Local Network Access permission", () => {
	it("unanswered → stays on queue WITHOUT probing, offers allow; the click's probe then goes direct", async () => {
		let perm: 'prompt' | 'granted' = 'prompt';
		const ff = fakeFetch((url) => (url.endsWith('/connection') ? connTailnet() : res(200, { name: 'B14' })));
		const s = new RobotSession('b14', { refreshMs: 0, flushMs: 0, fetchImpl: ff.f, permissionQuery: async () => perm });
		await s.open();
		expect(s.state.transport).toBe('queue');
		expect(s.state.needsPermission).toBe(true);
		expect(ff.urls.some((u) => u.startsWith(DIRECT))).toBe(false);
		perm = 'granted'; // operator clicked Allow in Chrome's prompt
		await s.retryDirect();
		expect(s.state.transport).toBe('direct');
		expect(s.state.needsPermission).toBe(false);
	});

	it('denied → queue with instructions, no probe', async () => {
		const ff = fakeFetch((url) => (url.endsWith('/connection') ? connTailnet() : res(200, {})));
		const s = new RobotSession('b14', { refreshMs: 0, flushMs: 0, fetchImpl: ff.f, permissionQuery: async () => 'denied' });
		await s.open();
		expect(s.state.transport).toBe('queue');
		expect(s.state.reason).toContain('Local network access');
		expect(ff.urls.some((u) => u.startsWith(DIRECT))).toBe(false);
	});
});

// ── OT2-TAILNET-5: robotFetch (the raw tracked request robot-client runs over) ──

describe('robotFetch', () => {
	const RELAY = '/api/opentrons-lab/robots/b14/relay';

	async function session(robotHandler: Handler, conn: () => Response = () => connTailnet()) {
		const posted: any[] = [];
		let opened = false;
		const ff = fakeFetch((url, init) => {
			if (url.endsWith('/connection')) return conn();
			if (!opened && url === `${DIRECT}/health`) return res(200, {}); // the open() probe
			if (url.endsWith('/direct-calls')) {
				posted.push(JSON.parse(String(init?.body)));
				return res(200, {});
			}
			if (url === RELAY) return res(200, { via: 'relay', sent: JSON.parse(String(init?.body)) });
			if (url.startsWith('/api/')) return res(200, { via: 'bims', url });
			return robotHandler(url, init);
		});
		const s = new RobotSession('b14', { ...opts, fetchImpl: ff.f });
		await s.open();
		opened = true;
		return { s, urls: ff.urls, posted };
	}

	it('direct: sends to the robot origin with opentrons-version 3 + JSON content type, and logs the call', async () => {
		const seen: { url: string; init?: RequestInit }[] = [];
		const { s, posted } = await session((url, init) => {
			seen.push({ url, init });
			return res(200, { ok: 1 });
		});
		const r = await s.robotFetch('/robot/lights', { method: 'POST', body: JSON.stringify({ on: true }) });
		expect(r.status).toBe(200);
		const call = seen.find((c) => c.url === `${DIRECT}/robot/lights`)!;
		const h = new Headers(call.init!.headers);
		expect(h.get('opentrons-version')).toBe('3');
		expect(h.get('content-type')).toBe('application/json');
		expect(call.init!.method).toBe('POST');
		await s.flush();
		expect(posted[0].calls).toEqual([
			expect.objectContaining({ verb: 'raw:POST /robot/lights', method: 'POST', path: '/robot/lights', status: 200, ok: true })
		]);
		expect(s.state.usedVia?.tailscale).toContain('raw:POST /robot/lights');
	});

	it("keeps a caller's opentrons-version; FormData gets no JSON content type", async () => {
		const seen: RequestInit[] = [];
		const { s } = await session((_u, init) => {
			seen.push(init!);
			return res(201, {});
		});
		const fd = new FormData();
		fd.append('files', new Blob(['x']), 'p.py');
		await s.robotFetch('/protocols', { method: 'POST', headers: { 'opentrons-version': '*' }, body: fd });
		const h = new Headers(seen.at(-1)!.headers);
		expect(h.get('opentrons-version')).toBe('*');
		expect(h.get('content-type')).toBeNull();
		expect(seen.at(-1)!.body).toBe(fd);
	});

	it('the /direct-calls verb is a path template, ≤ 40 chars', async () => {
		const { s, posted } = await session(() => res(200, {}));
		await s.robotFetch('/runs/3f2a9c1e-77aa-4b1d-9d7e-000000000001/commands?pageLength=10');
		await s.flush();
		expect(posted[0].calls[0].verb).toBe('raw:GET /runs/:id/commands');
		expect(posted[0].calls[0].verb.length).toBeLessThanOrEqual(40);
	});

	it('queue: goes through the BIMS relay as {method, path, body}, never the robot', async () => {
		const { s, urls } = await session(() => res(500, { unexpected: true }), () => res(200, { transport: 'queue', reason: 'queue', busy: null }));
		const r = await s.robotFetch('/settings', { method: 'POST', body: JSON.stringify({ id: 'a', value: true }) });
		expect(await r.json()).toEqual({ via: 'relay', sent: { method: 'POST', path: '/settings', body: { id: 'a', value: true } } });
		expect(urls.some((u) => u.startsWith(DIRECT))).toBe(false);
		expect(s.state.usedVia?.queue).toContain('raw:POST /settings');
	});

	it('queue: a multipart body or a file download answers 409 "needs Tailscale" without calling anything', async () => {
		const { s, urls } = await session(() => res(500, {}), () => res(200, { transport: 'queue', reason: 'queue', busy: null }));
		const before = urls.length;
		const up = await s.robotFetch('/dataFiles', { method: 'POST', body: new FormData() });
		expect(up.status).toBe(409);
		expect((await up.json()).message).toContain('needs Tailscale');
		const dl = await s.robotFetch('/logs/api.log?records=5000', { headers: { Accept: 'text/plain' } });
		expect(dl.status).toBe(409);
		expect(urls.length).toBe(before);
	});

	it('fallback: a GET with no answer is retried once via the relay, and the session stays on the queue', async () => {
		const { s, urls } = await session(() => {
			throw new TypeError('Failed to fetch');
		});
		const r = await s.robotFetch('/health');
		expect(await r.json()).toMatchObject({ via: 'relay', sent: { method: 'GET', path: '/health' } });
		expect(s.state.transport).toBe('queue');
		expect(s.state.fellBack).toBe(true);
		const before = urls.length;
		await s.robotFetch('/pipettes');
		expect(urls.slice(before)).toEqual([RELAY]); // sticky: no direct attempt
	});

	it('fallback: a mutating request with no answer is NOT retried (it may have happened) → 502', async () => {
		const { s, urls } = await session(() => {
			throw new TypeError('Failed to fetch');
		});
		const r = await s.robotFetch('/runs', { method: 'POST', body: JSON.stringify({ data: { protocolId: 'p' } }) });
		expect(r.status).toBe(502);
		expect((await r.json()).message).toContain('NOT retried');
		expect(urls).not.toContain(RELAY);
		expect(s.state.transport).toBe('queue');
	});

	it('fallback is logged to /direct-calls with the error', async () => {
		const { s, posted } = await session(() => {
			throw new TypeError('Failed to fetch');
		});
		await s.robotFetch('/health');
		await s.flush();
		expect(posted[0].calls[0]).toMatchObject({ verb: 'raw:GET /health', status: 0, ok: false, error: 'Failed to fetch' });
	});

	it("a robot 4xx is an answer: stays direct, no relay", async () => {
		const { s, urls } = await session(() => res(404, { errors: [{ detail: 'nope' }] }));
		const r = await s.robotFetch('/runs/abc12345678');
		expect(r.status).toBe(404);
		expect(s.state.transport).toBe('direct');
		expect(urls).not.toContain(RELAY);
	});

	it('while a daemon job holds the gantry, mutating raw calls go through the relay; reads stay direct', async () => {
		const { s, urls } = await session(() => res(200, {}), () => connTailnet({ kind: 'sweep', since: 'now' }));
		await s.robotFetch('/robot/home', { method: 'POST', body: JSON.stringify({ target: 'robot' }) });
		expect(urls).toContain(RELAY);
		expect(urls).not.toContain(`${DIRECT}/robot/home`);
		await s.robotFetch('/health');
		expect(urls.filter((u) => u === `${DIRECT}/health`).length).toBeGreaterThanOrEqual(2); // probe + read
	});

	it('rejects a path that is not on the robot origin', async () => {
		const { s } = await session(() => res(200, {}));
		expect((await s.robotFetch('https://evil.example/x')).status).toBe(400);
		expect((await s.robotFetch('//evil.example/x')).status).toBe(400);
	});
});

describe('the no-retry message names the verb', () => {
	it('keeps the TAILNET-4 wording for jog / tip pick-up and reads well for the new verbs', () => {
		expect(noRetryLabel('mx.jog')).toBe('jog');
		expect(noRetryLabel('mx.pickUpTip')).toBe('tip pick-up');
		expect(noRetryLabel('run.create')).toBe('run creation');
		expect(noRetryLabel('run.uploadProtocol')).toBe('protocol upload');
		expect(noRetryLabel('mx.command')).toBe('maintenance command');
	});

	it('call() records which line each verb ran on (pill tooltip)', async () => {
		const ff = fakeFetch((url) => {
			if (url.endsWith('/connection')) return connTailnet();
			if (url === `${DIRECT}/health`) return res(200, {});
			return res(201, {});
		});
		const s = new RobotSession('b14', { ...opts, fetchImpl: ff.f });
		await s.open();
		await s.call('run.action', { rid: 'r1', action: 'pause' });
		expect(s.state.usedVia).toEqual({ tailscale: ['run.action'], queue: [] });
	});
});
