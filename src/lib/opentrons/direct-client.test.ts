/**
 * The browser session's line rules (OT2-TAILNET-4):
 *   - one decision per page, visible, never silently mixed
 *   - no answer on the direct line → queue for the rest of the page (+ one retry
 *     through BIMS, except a relative jog, which must not run twice)
 *   - a queue session never talks to anything but BIMS (B07/R04 invariant)
 *   - motion defers to the queue while a daemon job holds the gantry
 */
import { describe, it, expect } from 'vitest';
import { RobotSession, routeToVerb } from './direct-client';

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
	it('maps only POSTs to the six motion routes', () => {
		expect(routeToVerb('/api/opentrons-lab/robots/b14/maintenance/m1/jog', 'POST')).toEqual({ robotId: 'b14', runId: 'm1', verb: 'mx.jog' });
		expect(routeToVerb('/api/opentrons-lab/robots/b14/maintenance/m1/move-to-well', 'POST')?.verb).toBe('mx.moveToWell');
		expect(routeToVerb('/api/opentrons-lab/robots/b14/maintenance/m1/pick-up-tip', 'POST')).toBeNull(); // writes studioTip → BIMS
		expect(routeToVerb('/api/opentrons-lab/robots/b14/maintenance/m1/load-labware', 'POST')).toBeNull();
		expect(routeToVerb('/api/opentrons-lab/robots/b14/maintenance', 'POST')).toBeNull(); // open run → AuditLog
		expect(routeToVerb('/api/opentrons-lab/robots/b14/maintenance/m1', 'DELETE')).toBeNull();
	});

	it('motion goes on the robot line; open/close/pick-up stay plain BIMS fetches', async () => {
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
		await s.fetchRoute('/api/opentrons-lab/robots/b14/maintenance/m1/pick-up-tip', { method: 'POST', body: '{}' });
		await s.fetchRoute('/api/opentrons-lab/robots/b14/maintenance', { method: 'POST', body: '{}' });
		expect(ff.urls).toContain('/api/opentrons-lab/robots/b14/maintenance/m1/pick-up-tip');
		expect(ff.urls).toContain('/api/opentrons-lab/robots/b14/maintenance');
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
