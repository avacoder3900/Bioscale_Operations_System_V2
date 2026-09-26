/**
 * The generic robot relay (OT2-TAILNET-5 §7.8.3 / S10a): the queue line for raw
 * robot-client calls.
 *   - GET needs manufacturing:read; POST/PATCH/DELETE need manufacturing:write
 *   - paths are robot-origin paths only (no scheme/host, no '..')
 *   - exactly ONE robot request through the existing proxy.ts exports
 *   - a mutating call writes an AuditLog row 'robot_relay'
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: { fn: string; robot: any; path: string; body?: unknown }[] = [];
const audits: any[] = [];
let robotAnswer: () => Promise<Response> = async () => new Response(JSON.stringify({ ok: 1 }), { status: 200 });

vi.mock('./proxy', () => {
	const rec = (fn: string) => async (robot: any, path: string, body?: unknown) => {
		calls.push({ fn, robot, path, ...(body !== undefined ? { body } : {}) });
		return robotAnswer();
	};
	return {
		getRobot: async (id: string) => (id === 'b14' ? { _id: 'b14', name: 'OT-2 B14', ip: '10.0.0.5' } : null),
		robotGet: rec('robotGet'),
		robotPost: rec('robotPost'),
		robotPatch: rec('robotPatch'),
		robotDelete: rec('robotDelete')
	};
});
vi.mock('$lib/server/db', () => ({
	connectDB: async () => {},
	generateId: () => 'nanoid_audit_1',
	AuditLog: { create: async (row: any) => void audits.push(row) }
}));

import { handleRelay, parseRelayRequest, sanitizeRelayPath, relayPermission } from './relay';

const READER = { _id: 'u1', username: 'reader', roles: [{ roleId: 'a', roleName: 'Viewer', permissions: ['manufacturing:read'] }] };
const WRITER = {
	_id: 'u2',
	username: 'writer',
	roles: [{ roleId: 'b', roleName: 'Mfg', permissions: ['manufacturing:read', 'manufacturing:write'] }]
};

function ev(user: any, payload: unknown, id = 'b14') {
	return {
		params: { id },
		locals: { user },
		request: new Request('https://bims.example/api/opentrons-lab/robots/b14/relay', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(payload)
		})
	};
}

async function status(p: Promise<Response>): Promise<number> {
	try {
		return (await p).status;
	} catch (e: any) {
		return e?.status ?? -1; // SvelteKit error() throws {status, body}
	}
}

beforeEach(() => {
	calls.length = 0;
	audits.length = 0;
	robotAnswer = async () => new Response(JSON.stringify({ ok: 1 }), { status: 200 });
});

describe('relay permissions', () => {
	it('GET needs manufacturing:read; mutating methods need manufacturing:write', () => {
		expect(relayPermission('GET')).toBe('manufacturing:read');
		for (const m of ['POST', 'PATCH', 'DELETE'] as const) expect(relayPermission(m)).toBe('manufacturing:write');
	});

	it('no user → 401; no manufacturing:read → 403; nothing reaches the robot', async () => {
		expect(await status(handleRelay(ev(null, { method: 'GET', path: '/health' })))).toBe(401);
		expect(await status(handleRelay(ev({ _id: 'x', username: 'x', roles: [] }, { method: 'GET', path: '/health' })))).toBe(403);
		expect(calls).toEqual([]);
	});

	it('a reader can GET', async () => {
		const r = await handleRelay(ev(READER, { method: 'GET', path: '/health' }));
		expect(r.status).toBe(200);
		expect(await r.json()).toEqual({ ok: 1 });
		expect(calls).toEqual([{ fn: 'robotGet', robot: expect.objectContaining({ _id: 'b14' }), path: '/health' }]);
		expect(audits).toEqual([]); // reads are not audited
	});

	it('a reader cannot POST / PATCH / DELETE (403, robot untouched, no audit)', async () => {
		for (const method of ['POST', 'PATCH', 'DELETE']) {
			expect(await status(handleRelay(ev(READER, { method, path: '/robot/lights', body: { on: true } })))).toBe(403);
		}
		expect(calls).toEqual([]);
		expect(audits).toEqual([]);
	});

	it('an unknown robot → 404', async () => {
		expect(await status(handleRelay(ev(WRITER, { method: 'GET', path: '/health' }, 'nope')))).toBe(404);
	});
});

describe('relay: one robot request through proxy.ts + AuditLog on mutation', () => {
	it('POST → robotPost with the JSON body, the robot status + body verbatim, an AuditLog row', async () => {
		robotAnswer = async () => new Response(JSON.stringify({ data: { id: 'run-1' } }), { status: 201 });
		const r = await handleRelay(ev(WRITER, { method: 'post', path: '/runs', body: { data: { protocolId: 'p1' } } }));
		expect(r.status).toBe(201);
		expect(r.headers.get('x-ot2-line')).toBe('queue');
		expect(await r.json()).toEqual({ data: { id: 'run-1' } });
		expect(calls).toEqual([{ fn: 'robotPost', robot: expect.anything(), path: '/runs', body: { data: { protocolId: 'p1' } } }]);
		expect(audits).toHaveLength(1);
		expect(audits[0]).toMatchObject({
			_id: 'nanoid_audit_1',
			action: 'robot_relay',
			tableName: 'opentrons_robots',
			recordId: 'b14',
			changedBy: 'writer',
			newData: { method: 'POST', path: '/runs', status: 201, line: 'queue' }
		});
	});

	it('PATCH → robotPatch, DELETE → robotDelete, each audited', async () => {
		await handleRelay(ev(WRITER, { method: 'PATCH', path: '/errorRecovery/settings', body: { data: { enabled: true } } }));
		await handleRelay(ev(WRITER, { method: 'DELETE', path: '/protocols/abc' }));
		expect(calls.map((c) => c.fn)).toEqual(['robotPatch', 'robotDelete']);
		expect(audits.map((a) => a.newData.method)).toEqual(['PATCH', 'DELETE']);
	});

	it('a robot error is the robot answer (status + body), still audited', async () => {
		robotAnswer = async () => new Response(JSON.stringify({ errors: [{ detail: 'busy' }] }), { status: 409 });
		const r = await handleRelay(ev(WRITER, { method: 'POST', path: '/robot/home', body: { target: 'robot' } }));
		expect(r.status).toBe(409);
		expect(await r.json()).toEqual({ errors: [{ detail: 'busy' }] });
		expect(audits[0].newData.status).toBe(409);
	});

	it('no answer from the robot / queue → 502 with a message, audited as 502', async () => {
		robotAnswer = async () => {
			throw new Error('robot bridge "ot2-b14-bridge" did not respond within 30s');
		};
		const r = await handleRelay(ev(WRITER, { method: 'POST', path: '/robot/lights', body: { on: false } }));
		expect(r.status).toBe(502);
		expect((await r.json()).message).toContain('did not respond');
		expect(audits[0].newData.status).toBe(502);
	});

	it('PUT (no proxy.ts robotPut) → 405 "use Tailscale", nothing sent', async () => {
		const r = await handleRelay(ev(WRITER, { method: 'PUT', path: '/system/time', body: {} }));
		expect(r.status).toBe(405);
		expect((await r.json()).message).toContain('Tailscale');
		expect(calls).toEqual([]);
	});

	it('a 204 answer carries no body', async () => {
		robotAnswer = async () => new Response(null, { status: 204 });
		const r = await handleRelay(ev(WRITER, { method: 'DELETE', path: '/clientData' }));
		expect(r.status).toBe(204);
	});
});

describe('relay path sanitising', () => {
	it('accepts plain robot paths with a query', () => {
		for (const p of ['/health', '/runs?pageLength=10', '/runs/abc/commands?cursor=0&pageLength=999', '/bridge/jobs/j1']) {
			expect(sanitizeRelayPath(p)).toBe(p);
		}
	});

	it('rejects schemes, hosts, traversal and junk', () => {
		for (const p of [
			'',
			'health',
			'//evil.example/x',
			'http://10.0.0.5:31950/health',
			'https:/x',
			'/../etc/passwd',
			'/runs/../../x',
			'/runs/%2e%2e/x',
			'/./health',
			'/a\\b',
			'/a\nb',
			'/%ZZ',
			'/' + 'a'.repeat(2001),
			123,
			null
		]) {
			expect(sanitizeRelayPath(p as any)).toBeNull();
		}
	});

	it('a bad path is a 400 before the robot or the write check', async () => {
		expect(await status(handleRelay(ev(WRITER, { method: 'GET', path: 'http://evil/x' })))).toBe(400);
		expect(await status(handleRelay(ev(WRITER, { method: 'POST', path: '/x/../y' })))).toBe(400);
		expect(calls).toEqual([]);
	});

	it('the body must be {method, path, body?}', () => {
		expect(parseRelayRequest(null)).toMatchObject({ ok: false, status: 400 });
		expect(parseRelayRequest([])).toMatchObject({ ok: false, status: 400 });
		expect(parseRelayRequest({ path: '/health' })).toEqual({ ok: true, req: { method: 'GET', path: '/health' } });
	});
});
