/**
 * POST /api/opentrons-lab/robots/:id/verb — the queue line for the
 * OT2-TAILNET-5 lifecycle verbs. G4: LPC's arbitrary maintenance commands now
 * reach it as mx.command (session.call), so this pins that path:
 *   - manufacturing:write, runId from the query, JSON args from the body
 *   - ONE verbResponse (the shared verb over the queue transport)
 *   - an AuditLog row 'robot_verb' (the relay used to audit these as 'robot_relay')
 *   - other lifecycle verbs write no audit row here (their confirms do)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const verbCalls: { robot: any; verb: string; args: any; user: any }[] = [];
const audits: any[] = [];
let answer = { status: 200, body: { ok: true, command: { id: 'c1', status: 'succeeded', result: { position: { x: 1 } } } } };

vi.mock('$lib/server/opentrons/proxy', () => ({
	getRobot: async (id: string) => (id === 'b14' ? { _id: 'b14', name: 'OT-2 B14', ip: '10.0.0.5' } : null)
}));
vi.mock('$lib/server/opentrons/transport', () => ({
	verbResponse: async (robot: any, verb: string, args: any, user: any) => {
		verbCalls.push({ robot, verb, args, user });
		return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json' } });
	}
}));
vi.mock('$lib/server/db', () => ({
	connectDB: async () => {},
	generateId: () => 'nanoid_audit_1',
	AuditLog: { create: async (row: any) => void audits.push(row) }
}));

import { POST } from './+server';

const READER = { _id: 'u1', username: 'reader', roles: [{ roleId: 'a', roleName: 'Viewer', permissions: ['manufacturing:read'] }] };
const WRITER = {
	_id: 'u2',
	username: 'writer',
	roles: [{ roleId: 'b', roleName: 'Mfg', permissions: ['manufacturing:read', 'manufacturing:write'] }]
};

function post(user: any, query: string, body: unknown) {
	const url = new URL(`https://bims.example/api/opentrons-lab/robots/b14/verb?${query}`);
	return (POST as any)({
		params: { id: 'b14' },
		locals: { user },
		url,
		request: new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
	}) as Promise<Response>;
}

async function status(p: Promise<Response>): Promise<number> {
	try {
		return (await p).status;
	} catch (e: any) {
		return e?.status ?? -1;
	}
}

beforeEach(() => {
	verbCalls.length = 0;
	audits.length = 0;
	answer = { status: 200, body: { ok: true, command: { id: 'c1', status: 'succeeded', result: { position: { x: 1 } } } } };
});

describe('/verb mx.command (LPC queue fallback)', () => {
	it('runs the shared verb once with runId from the query + the body args, and audits it', async () => {
		const r = await post(WRITER, 'verb=mx.command&runId=m1', { commandType: 'savePosition', params: { pipetteId: 'p' }, timeoutMs: 60_000 });
		expect(r.status).toBe(200);
		expect(await r.json()).toEqual(answer.body);
		expect(verbCalls).toEqual([
			{
				robot: expect.objectContaining({ _id: 'b14' }),
				verb: 'mx.command',
				args: { commandType: 'savePosition', params: { pipetteId: 'p' }, timeoutMs: 60_000, runId: 'm1' },
				user: { username: 'writer' }
			}
		]);
		expect(audits).toHaveLength(1);
		expect(audits[0]).toMatchObject({
			_id: 'nanoid_audit_1',
			tableName: 'opentrons_robots',
			recordId: 'b14',
			action: 'robot_verb',
			changedBy: 'writer',
			newData: { verb: 'mx.command', runId: 'm1', commandType: 'savePosition', status: 200, line: 'queue' }
		});
	});

	it('a robot failure is still the robot answer, and still audited', async () => {
		answer = { status: 502, body: { message: 'home failed: [PipetteNotAttached] no pipette' } as any };
		const r = await post(WRITER, 'verb=mx.command&runId=m1', { commandType: 'home', params: {} });
		expect(r.status).toBe(502);
		expect(audits[0].newData.status).toBe(502);
	});

	it('a reader cannot send one (403, robot untouched, no audit)', async () => {
		expect(await status(post(READER, 'verb=mx.command&runId=m1', { commandType: 'home' }))).toBe(403);
		expect(verbCalls).toEqual([]);
		expect(audits).toEqual([]);
	});

	it('other lifecycle verbs write no audit row here; unknown verbs are refused', async () => {
		await post(READER, 'verb=run.list', {});
		expect(verbCalls.map((c) => c.verb)).toEqual(['run.list']);
		expect(audits).toEqual([]);
		const r = await post(WRITER, 'verb=mx.jog&runId=m1', {});
		expect(r.status).toBe(400);
		expect(verbCalls).toHaveLength(1);
	});
});
