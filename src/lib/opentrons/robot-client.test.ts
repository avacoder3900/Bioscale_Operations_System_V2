/**
 * The isomorphic robot client (OT2-TAILNET-5 S10a).
 *   - openapi-fetch + opentrons-version, with the fetch injected
 *   - the browser client runs over session.robotFetch (path-based)
 *   - mx.command (LPC's arbitrary maintenance commands) = the shared
 *     ot2-protocol sendMaintenanceCommand over the session
 *   - AC: the same client call produces the same robot request (method, path,
 *     body, headers) on the direct line and through the BIMS relay
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The relay route + the REAL proxy.ts run in the parity test; only Mongo is faked.
const ROBOT = { _id: 'b14', name: 'OT-2 B14', ip: '10.0.0.5', port: 31950, isActive: true };
vi.mock('$lib/server/db', () => ({
	connectDB: async () => {},
	generateId: () => 'nanoid_x',
	AuditLog: { create: async () => {} },
	OpentronsRobot: { findById: (id: string) => ({ lean: async () => (id === ROBOT._id ? ROBOT : null) }) },
	Ot2BridgeCommand: {},
	ScannerEvent: {},
	LabwareDefinition: {}
}));

import {
	createRobotClient,
	sessionRobotClient,
	robotFetchAdapter,
	robotFetchTransport,
	maintenanceCommand,
	readDeviceLive,
	TIMEOUT_HEADER,
	type RawRobotFetch
} from './robot-client';
import { RobotSession } from './direct-client';
import { createRobotClient as serverClient } from '$lib/server/opentrons/client';
import { handleRelay } from '$lib/server/opentrons/relay';

const DIRECT = 'https://ot2-b14.tailf65a70.ts.net';
const LAN = 'http://10.0.0.5:31950';
const json = (status: number, body: unknown) =>
	new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type RawCall = { path: string; init: RequestInit & { timeoutMs?: number } };
function recorder(answer: (path: string) => Response = () => json(200, { data: [] })) {
	const calls: RawCall[] = [];
	const raw: RawRobotFetch = async (path, init = {}) => {
		calls.push({ path, init });
		return answer(path);
	};
	return { raw, calls };
}

describe('createRobotClient (injected fetch)', () => {
	it("sets opentrons-version '*' (today's server client) unless the caller set one", async () => {
		const seen: Request[] = [];
		const c = createRobotClient({
			baseUrl: LAN,
			fetch: async (req) => {
				seen.push(req);
				return json(200, { name: 'B14' });
			}
		});
		await c.GET('/health', {} as any);
		await c.GET('/health', { headers: { 'opentrons-version': '3' } } as any);
		expect(seen[0].url).toBe(`${LAN}/health`);
		expect(seen[0].headers.get('opentrons-version')).toBe('*');
		expect(seen[1].headers.get('opentrons-version')).toBe('3');
		expect(seen[0].signal).toBeTruthy();
	});

	it('the server wrapper (client.ts, scripts) binds the LAN address exactly as before', async () => {
		const seen: string[] = [];
		const orig = globalThis.fetch;
		globalThis.fetch = (async (req: Request) => {
			seen.push(`${req.url} ${req.headers.get('opentrons-version')}`);
			return json(200, {});
		}) as any;
		try {
			await serverClient({ ip: '10.0.0.5' }).GET('/health', {} as any);
		} finally {
			globalThis.fetch = orig;
		}
		expect(seen).toEqual([`${LAN}/health *`]);
	});
});

describe('sessionRobotClient (browser, over session.robotFetch)', () => {
	it('a typed GET becomes robotFetch(path + query), no header forced (the session sets opentrons-version)', async () => {
		const { raw, calls } = recorder();
		const c = sessionRobotClient({ robotFetch: raw });
		await c.GET('/runs', { params: { query: { pageLength: 10 } } } as any);
		expect(calls).toHaveLength(1);
		expect(calls[0].path).toBe('/runs?pageLength=10');
		expect(calls[0].init.method).toBe('GET');
		expect(new Headers(calls[0].init.headers).get('opentrons-version')).toBeNull();
		expect(calls[0].init.body).toBeUndefined();
	});

	it('a JSON body stays a string (so the relay can carry it)', async () => {
		const { raw, calls } = recorder(() => json(200, { on: true }));
		const c = sessionRobotClient({ robotFetch: raw });
		const r = await c.POST('/robot/lights', { body: { on: true } } as any);
		expect(r.data).toEqual({ on: true });
		expect(calls[0].init.method).toBe('POST');
		expect(calls[0].init.body).toBe(JSON.stringify({ on: true }));
	});

	it('the per-request timeout header becomes timeoutMs and never reaches the robot', async () => {
		const { raw, calls } = recorder();
		const c = sessionRobotClient({ robotFetch: raw });
		await c.POST('/robot/home', { body: { target: 'robot' }, headers: { [TIMEOUT_HEADER]: '65000' } } as any);
		expect(calls[0].init.timeoutMs).toBe(65000);
		expect(new Headers(calls[0].init.headers).has(TIMEOUT_HEADER)).toBe(false);
	});

	it('a multipart body goes as bytes with its boundary content type (direct-only on the session)', async () => {
		const { raw, calls } = recorder(() => json(201, { data: { id: 'p1' } }));
		const adapter = robotFetchAdapter(raw);
		const fd = new FormData();
		fd.append('files', new Blob(['print(1)']), 'p.py');
		await adapter(new Request('http://ot2-session.invalid/protocols', { method: 'POST', body: fd }));
		expect(calls[0].init.body).toBeInstanceOf(ArrayBuffer);
		expect(new Headers(calls[0].init.headers).get('content-type')).toMatch(/^multipart\/form-data; boundary=/);
	});
});

describe('maintenanceCommand (mx.command: LPC)', () => {
	it('POST /maintenance_runs/:id/commands with waitUntilComplete — the shared sendMaintenanceCommand request', async () => {
		const { raw, calls } = recorder(() => json(201, { data: { id: 'c1', commandType: 'home', status: 'succeeded', result: {} } }));
		const out = await maintenanceCommand(raw, 'mr-1', { commandType: 'home', params: {} }, { timeoutMs: 60_000 });
		expect(out).toMatchObject({ id: 'c1', status: 'succeeded' });
		expect(calls[0].path).toBe('/maintenance_runs/mr-1/commands?waitUntilComplete=true&timeout=60000');
		expect(calls[0].init.method).toBe('POST');
		expect(JSON.parse(String(calls[0].init.body))).toEqual({ data: { commandType: 'home', intent: 'setup', params: {} } });
		expect(calls[0].init.timeoutMs).toBeGreaterThan(60_000); // transport outlives the robot's own wait
	});

	it('refuses a commandType outside the LPC allow-list without calling the robot', async () => {
		const { raw, calls } = recorder();
		await expect(maintenanceCommand(raw, 'mr-1', { commandType: 'aspirate', params: {} })).rejects.toThrow(/commandType must be one of/);
		expect(calls).toEqual([]);
	});

	it('a 201 carrying status:failed throws (the OT-2 reports command failure in the body)', async () => {
		const { raw } = recorder(() => json(201, { data: { id: 'c1', commandType: 'moveToWell', status: 'failed', error: { detail: 'out of reach' } } }));
		await expect(maintenanceCommand(raw, 'mr-1', { commandType: 'moveToWell', params: {} })).rejects.toThrow(/out of reach/);
	});

	it("the session's no-retry 502 surfaces as the error (never repeated)", async () => {
		const { raw, calls } = recorder(() => json(502, { message: 'Direct link lost … It was NOT retried' }));
		await expect(maintenanceCommand(raw, 'mr-1', { commandType: 'moveRelative', params: {} })).rejects.toThrow(/NOT retried/);
		expect(calls).toHaveLength(1);
	});
});

describe('readDeviceLive (S7 device page)', () => {
	it("maps /health, /pipettes, /runs to the old server load's shape", async () => {
		const { raw } = recorder((p) =>
			p === '/health'
				? json(200, { name: 'B14', api_version: '8.0.0', fw_version: 'v1', robot_serial: 'OT2X' })
				: p === '/pipettes'
					? json(200, { left: { model: 'p20' }, right: { model: null } })
					: json(200, { data: [{ id: 'r1', status: 'succeeded', protocolId: 'p1', createdAt: 't' }] })
		);
		const out = await readDeviceLive(sessionRobotClient({ robotFetch: raw }), 'fallback');
		expect(out.robotOffline).toBe(false);
		expect(out.info?.health).toMatchObject({ name: 'B14', api_version: '8.0.0', fw_version: 'v1', robot_serial: 'OT2X' });
		expect(out.info?.pipettes).toEqual([
			{ mount: 'left', model: 'p20' },
			{ mount: 'right', model: null }
		]);
		expect(out.recentRuns).toEqual([{ id: 'r1', status: 'succeeded', protocolId: 'p1', createdAt: 't', completedAt: null }]);
	});

	it('robot offline → robotOffline, no further calls', async () => {
		const { raw, calls } = recorder(() => json(502, { message: 'no answer' }));
		const out = await readDeviceLive(sessionRobotClient({ robotFetch: raw }));
		expect(out).toEqual({ robotOffline: true, info: null, recentRuns: null });
		expect(calls.map((c) => c.path)).toEqual(['/health']);
	});
});

// ── S10a AC: direct fetch vs relay parity ────────────────────────────────────

type RobotRequest = { method: string; path: string; body: unknown; headers: Record<string, string> };
const ROBOT_HEADERS = ['opentrons-version', 'content-type'];

async function robotRequestOf(url: string, init: RequestInit | undefined, origin: string): Promise<RobotRequest> {
	const h = new Headers(init?.headers);
	const headers: Record<string, string> = {};
	for (const k of ROBOT_HEADERS) if (h.has(k)) headers[k] = h.get(k)!;
	const raw = init?.body;
	return {
		method: (init?.method ?? 'GET').toUpperCase(),
		path: url.slice(origin.length),
		body: typeof raw === 'string' && raw.length ? JSON.parse(raw) : raw == null ? null : raw,
		headers
	};
}

const WRITER = {
	_id: 'u2',
	username: 'writer',
	roles: [{ roleId: 'b', roleName: 'Mfg', permissions: ['manufacturing:read', 'manufacturing:write'] }]
};
const sessionOpts = { refreshMs: 0, flushMs: 0, permissionQuery: async () => 'granted' as const };

/** A tailnet session: robot requests land at DIRECT and are recorded. */
async function directLine(robotAnswer: () => Response) {
	const seen: RobotRequest[] = [];
	let opened = false;
	const s = new RobotSession('b14', {
		...sessionOpts,
		fetchImpl: (async (input: any, init?: RequestInit) => {
			const url = String(input);
			if (url.endsWith('/connection')) return json(200, { transport: 'tailnet', directUrl: DIRECT, reason: 'tailnet', busy: null });
			if (url.endsWith('/direct-calls')) return json(200, {});
			if (!opened && url === `${DIRECT}/health`) return json(200, {});
			if (!url.startsWith(DIRECT)) throw new Error(`direct line called BIMS: ${url}`);
			seen.push(await robotRequestOf(url, init, DIRECT));
			return robotAnswer();
		}) as typeof fetch
	});
	await s.open();
	opened = true;
	expect(s.state.transport).toBe('direct');
	return { client: sessionRobotClient(s), session: s, seen };
}

/**
 * A queue session: the browser POSTs /relay, which runs the REAL relay route
 * and the REAL proxy.ts (LAN mode, OT2_TRANSPORT=direct) — the robot request
 * proxy.ts sends is recorded off global fetch.
 */
async function relayLine(robotAnswer: () => Response) {
	const seen: RobotRequest[] = [];
	const relayed: unknown[] = [];
	vi.stubGlobal('fetch', async (input: any, init?: RequestInit) => {
		const url = String(input);
		if (!url.startsWith(LAN)) throw new Error(`proxy dialled ${url}`);
		seen.push(await robotRequestOf(url, init, LAN));
		return robotAnswer();
	});
	const s = new RobotSession('b14', {
		...sessionOpts,
		fetchImpl: (async (input: any, init?: RequestInit) => {
			const url = String(input);
			if (url.endsWith('/connection')) return json(200, { transport: 'queue', reason: 'queue', busy: null });
			if (url === '/api/opentrons-lab/robots/b14/relay') {
				relayed.push(JSON.parse(String(init?.body)));
				return handleRelay({
					params: { id: 'b14' },
					locals: { user: WRITER },
					request: new Request(`https://bims.example${url}`, init)
				});
			}
			throw new Error(`queue line called ${url}`);
		}) as typeof fetch
	});
	await s.open();
	expect(s.state.transport).toBe('queue');
	return { client: sessionRobotClient(s), session: s, seen, relayed };
}

describe('S10a: the same robot-client call → the same robot request on both lines', () => {
	const prevTransport = process.env.OT2_TRANSPORT;
	beforeEach(() => {
		process.env.OT2_TRANSPORT = 'direct'; // proxy.ts dials the LAN (local-dev mode) so we can see its request
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		if (prevTransport === undefined) delete process.env.OT2_TRANSPORT;
		else process.env.OT2_TRANSPORT = prevTransport;
	});

	const cases: Array<{ name: string; call: (c: ReturnType<typeof sessionRobotClient>, raw: RawRobotFetch) => Promise<unknown>; answer: () => Response }> = [
		{ name: 'GET /runs?pageLength=10', call: (c) => c.GET('/runs', { params: { query: { pageLength: 10 } } } as any), answer: () => json(200, { data: [] }) },
		{ name: 'POST /robot/lights', call: (c) => c.POST('/robot/lights', { body: { on: true } } as any), answer: () => json(200, { on: true }) },
		{
			name: 'POST /runs/{runId}/actions',
			call: (c) => c.POST('/runs/{runId}/actions', { params: { path: { runId: 'run-1' } }, body: { data: { actionType: 'pause' } } } as any),
			answer: () => json(201, { data: { id: 'a1' } })
		},
		{
			name: 'PATCH /errorRecovery/settings',
			call: (c) => c.PATCH('/errorRecovery/settings', { body: { data: { enabled: false } } } as any),
			answer: () => json(200, { data: { enabled: false } })
		},
		{ name: 'DELETE /protocols/{protocolId}', call: (c) => c.DELETE('/protocols/{protocolId}', { params: { path: { protocolId: 'p1' } } } as any), answer: () => json(200, {}) },
		{
			name: 'mx.command home (LPC)',
			call: (_c, raw) => maintenanceCommand(raw, 'mr-1', { commandType: 'home', params: {} }),
			answer: () => json(201, { data: { id: 'c1', commandType: 'home', status: 'succeeded' } })
		}
	];

	for (const tc of cases) {
		it(tc.name, async () => {
			const d = await directLine(tc.answer);
			const q = await relayLine(tc.answer);
			const dOut = await tc.call(d.client, (p, i) => d.session.robotFetch(p, i));
			const qOut = await tc.call(q.client, (p, i) => q.session.robotFetch(p, i));

			expect(d.seen).toHaveLength(1);
			expect(q.seen).toHaveLength(1);
			expect(q.seen[0]).toEqual(d.seen[0]);
			// Not vacuous: the request is a real robot request with the robot's header.
			expect(d.seen[0].headers['opentrons-version']).toBe('3');
			expect(d.seen[0].path.startsWith('/')).toBe(true);
			if (d.seen[0].method !== 'GET' && d.seen[0].method !== 'DELETE') {
				expect(d.seen[0].headers['content-type']).toBe('application/json');
				expect(d.seen[0].body).not.toBeNull();
			}
			// …and the caller sees the same answer on both lines.
			const strip = (o: any) => (o && typeof o === 'object' && 'response' in o ? { data: o.data, error: o.error, status: o.response.status } : o);
			expect(strip(qOut)).toEqual(strip(dOut));
			expect(q.relayed).toHaveLength(1);
		});
	}

	it('robotFetchTransport runs a shared ot2-protocol helper identically on both lines', async () => {
		const d = await directLine(() => json(200, { ok: true }));
		const q = await relayLine(() => json(200, { ok: true }));
		await robotFetchTransport((p, i) => d.session.robotFetch(p, i)).post('/robot/home', { target: 'robot' });
		await robotFetchTransport((p, i) => q.session.robotFetch(p, i)).post('/robot/home', { target: 'robot' });
		expect(q.seen).toEqual(d.seen);
		expect(d.seen).toEqual([
			{ method: 'POST', path: '/robot/home', body: { target: 'robot' }, headers: { 'opentrons-version': '3', 'content-type': 'application/json' } }
		]);
	});

	it('the pinned requests', async () => {
		const d = await directLine(() => json(201, { data: { id: 'c1', commandType: 'home', status: 'succeeded' } }));
		await d.client.GET('/runs', { params: { query: { pageLength: 10 } } } as any);
		await maintenanceCommand((p, i) => d.session.robotFetch(p, i), 'mr-1', { commandType: 'home', params: {} });
		expect(d.seen).toEqual([
			{ method: 'GET', path: '/runs?pageLength=10', body: null, headers: { 'opentrons-version': '3' } },
			{
				method: 'POST',
				path: '/maintenance_runs/mr-1/commands?waitUntilComplete=true&timeout=30000',
				body: { data: { commandType: 'home', intent: 'setup', params: {} } },
				headers: { 'opentrons-version': '3', 'content-type': 'application/json' }
			}
		]);
	});
});
