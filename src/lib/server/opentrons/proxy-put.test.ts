/**
 * proxy.ts robotPut (OT2-TAILNET-5 G3) is robotPatch with a different verb:
 *   bridge transport → ONE kind:'http' Ot2BridgeCommand {method:'PUT', path, body}
 *   direct transport → fetch robot:31950 with opentrons-version 3 + JSON body
 * and robotPatch itself is unchanged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const created: any[] = [];

vi.mock('$lib/server/db', () => ({
	connectDB: async () => {},
	generateId: () => `cmd_${created.length + 1}`,
	OpentronsRobot: {},
	ScannerEvent: {},
	LabwareDefinition: {},
	Ot2BridgeCommand: {
		create: async (doc: any) => {
			created.push(doc);
			return doc;
		},
		findById: (_id: string) => ({
			select: () => ({ lean: async () => ({ status: 'completed', result: { status: 200, body: { ok: 1 } } }) })
		}),
		updateOne: async () => ({})
	}
}));

import { robotPatch, robotPut } from './proxy';

const ROBOT = { _id: 'b14', name: 'OT-2 B14', ip: '10.0.0.5' };
const BODY = { data: { systemTime: '2026-09-26T12:00:00Z' } };

let savedTransport: string | undefined;
beforeEach(() => {
	created.length = 0;
	savedTransport = process.env.OT2_TRANSPORT;
});
afterEach(() => {
	if (savedTransport === undefined) delete process.env.OT2_TRANSPORT;
	else process.env.OT2_TRANSPORT = savedTransport;
	vi.unstubAllGlobals();
});

describe('robotPut over the queue (bridge transport)', () => {
	it("enqueues one kind:'http' command with method PUT — the same command robotPatch makes, verb aside", async () => {
		process.env.OT2_TRANSPORT = 'bridge';
		const put = await robotPut(ROBOT, '/system/time', BODY);
		const patch = await robotPatch(ROBOT, '/system/time', BODY);
		expect(put.status).toBe(200);
		expect(await put.json()).toEqual({ ok: 1 });
		expect(patch.status).toBe(200);
		expect(created).toHaveLength(2);
		expect(created[0]).toMatchObject({
			robotId: 'b14',
			deviceId: 'ot2-b14-bridge',
			kind: 'http',
			request: { method: 'PUT', path: '/system/time', body: BODY }
		});
		const { _id: _a, request: rPut, ...restPut } = created[0];
		const { _id: _b, request: rPatch, ...restPatch } = created[1];
		expect(restPut).toEqual(restPatch);
		expect({ ...rPut, method: 'X' }).toEqual({ ...rPatch, method: 'X' });
		expect(rPatch.method).toBe('PATCH');
	});

	it('no body → body null (as robotPatch)', async () => {
		process.env.OT2_TRANSPORT = 'bridge';
		await robotPut(ROBOT, '/clientData/k');
		expect(created[0].request).toEqual({ method: 'PUT', path: '/clientData/k', body: null });
	});
});

describe('robotPut on the LAN (direct transport)', () => {
	it('PUT http://ip:31950/path with opentrons-version 3 and a JSON body', async () => {
		process.env.OT2_TRANSPORT = 'direct';
		const seen: { url: string; init: RequestInit }[] = [];
		vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
			seen.push({ url, init });
			return new Response('{}', { status: 200 });
		});
		await robotPut(ROBOT, '/clientData/k', { data: { a: 1 } });
		expect(seen[0].url).toBe('http://10.0.0.5:31950/clientData/k');
		expect(seen[0].init.method).toBe('PUT');
		expect(seen[0].init.headers).toEqual({ 'Content-Type': 'application/json', 'opentrons-version': '3' });
		expect(seen[0].init.body).toBe(JSON.stringify({ data: { a: 1 } }));
		expect(created).toEqual([]);
	});
});
