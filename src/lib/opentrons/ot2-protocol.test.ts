/**
 * The shared robot protocol must answer EXACTLY as the BIMS routes did before
 * OT2-TAILNET-4 moved their logic here — both lines (queue route, tailnet
 * browser) now run this code, so a regression here changes both at once.
 * Expected values below are the pre-refactor route behaviour.
 */
import { describe, it, expect } from 'vitest';
import { runVerb, verbRoute, browserTransport, type Ot2Transport } from './ot2-protocol';

type Call = { method: 'GET' | 'POST' | 'DELETE'; path: string; body?: any; timeoutMs?: number };

function robot(respond: (c: Call) => Response | Promise<Response>) {
	const calls: Call[] = [];
	const t: Ot2Transport = {
		get: async (path, o) => {
			const c: Call = { method: 'GET', path, timeoutMs: o?.timeoutMs };
			calls.push(c);
			return respond(c);
		},
		post: async (path, body, o) => {
			const c: Call = { method: 'POST', path, body, timeoutMs: o?.timeoutMs };
			calls.push(c);
			return respond(c);
		},
		delete: async (path) => {
			const c: Call = { method: 'DELETE', path };
			calls.push(c);
			return respond(c);
		}
	};
	return { t, calls };
}
const res = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const okCmd = (result: unknown = {}) => res(201, { data: { status: 'succeeded', result } });

describe('run.get', () => {
	it('passes the robot JSON through with 200', async () => {
		const { t, calls } = robot(() => res(200, { data: { status: 'paused' } }));
		const r = await runVerb(t, 'run.get', { rid: 'r1' });
		expect(calls[0]).toMatchObject({ method: 'GET', path: '/runs/r1' });
		expect(r).toEqual({ status: 200, body: { data: { status: 'paused' } } });
	});
	it('keeps 200 even when the robot answers 404 (route never checked res.ok)', async () => {
		const { t } = robot(() => res(404, { errors: [{ detail: 'nope' }] }));
		expect((await runVerb(t, 'run.get', { rid: 'x' })).status).toBe(200);
	});
	it('no answer → 502 "Failed to reach robot"', async () => {
		const { t } = robot(() => {
			throw new TypeError('Failed to fetch');
		});
		const r = await runVerb(t, 'run.get', { rid: 'x' });
		expect(r.status).toBe(502);
		expect((r.body as any).message).toBe('Failed to reach robot: Failed to fetch');
	});
});

describe('run.action', () => {
	it('maps resume → play (the OT-2 has no resume actionType)', async () => {
		const { t, calls } = robot(() => res(201, {}));
		const r = await runVerb(t, 'run.action', { rid: 'r1', action: 'resume' });
		expect(calls[0]).toMatchObject({ method: 'POST', path: '/runs/r1/actions', body: { data: { actionType: 'play' } } });
		expect(r).toEqual({ status: 200, body: { ok: true, action: 'resume' } });
	});
	it('robot 4xx → 409 conflict (benign: already paused)', async () => {
		const { t } = robot(() => res(409, { errors: [{ detail: 'already paused' }] }));
		const r = await runVerb(t, 'run.action', { rid: 'r1', action: 'pause' });
		expect(r).toEqual({
			status: 409,
			body: { ok: false, action: 'pause', robotStatus: 409, detail: 'already paused', conflict: true }
		});
	});
	it('robot 5xx → 502 with detail', async () => {
		const { t } = robot(() => res(500, {}));
		const r = await runVerb(t, 'run.action', { rid: 'r1', action: 'stop' });
		expect(r.status).toBe(502);
		expect(r.body).toMatchObject({ ok: false, detail: 'Robot returned 500', conflict: false });
	});
	it('rejects unknown actions without touching the robot', async () => {
		const { t, calls } = robot(() => res(200, {}));
		const r = await runVerb(t, 'run.action', { rid: 'r1', action: 'explode' });
		expect(r).toEqual({ status: 400, body: { message: 'action must be play, pause, stop, or resume' } });
		expect(calls).toHaveLength(0);
	});
});

describe('maintenance verbs', () => {
	it('jog: leftZ → z, waitUntilComplete, client abort = timeout + 10s', async () => {
		const { t, calls } = robot(() => okCmd());
		const r = await runVerb(t, 'mx.jog', { runId: 'm1', pipetteId: 'p', axis: 'leftZ', distance: -0.5 });
		expect(r).toEqual({ status: 200, body: { ok: true } });
		expect(calls[0].path).toBe('/maintenance_runs/m1/commands?waitUntilComplete=true&timeout=30000');
		expect(calls[0].body).toEqual({ data: { commandType: 'moveRelative', intent: 'setup', params: { pipetteId: 'p', axis: 'z', distance: -0.5 } } });
		expect(calls[0].timeoutMs).toBe(40_000);
	});
	it('HTTP 201 with data.status=failed is a failure (502), not success', async () => {
		const { t } = robot(() => res(201, { data: { status: 'failed', error: { errorType: 'MustHomeError', detail: 'home first' } } }));
		const r = await runVerb(t, 'mx.jog', { runId: 'm1', pipetteId: 'p', axis: 'x', distance: 1 });
		expect(r).toEqual({ status: 502, body: { message: 'moveRelative failed: [MustHomeError] home first' } });
	});
	it('FastAPI 422 detail[] is surfaced with the field path', async () => {
		const { t } = robot(() => res(422, { detail: [{ loc: ['body', 'data', 'params'], msg: 'field required' }] }));
		const r = await runVerb(t, 'mx.home', { runId: 'm1' });
		expect((r.body as any).message).toBe('home: body.data.params: field required');
	});
	it('validation messages match the old routes', async () => {
		const { t, calls } = robot(() => okCmd());
		expect((await runVerb(t, 'mx.jog', { runId: 'm', axis: 'x', distance: 1 })).body).toEqual({ message: 'pipetteId required' });
		expect((await runVerb(t, 'mx.jog', { runId: 'm', pipetteId: 'p', axis: 'q', distance: 1 })).body).toEqual({ message: 'axis must be one of x, y, leftZ, rightZ' });
		expect((await runVerb(t, 'mx.moveTo', { runId: 'm', pipetteId: 'p', x: 1, y: 2, z: 3, speed: 0 })).body).toEqual({ message: 'speed must be a positive finite number (mm/s)' });
		expect((await runVerb(t, 'mx.moveToWell', { runId: 'm', pipetteId: 'p', wellName: 'A1' })).body).toEqual({ message: 'labwareId required' });
		expect(calls).toHaveLength(0);
	});
	it('moveTo defaults forceDirect true and omits unset optionals', async () => {
		const { t, calls } = robot(() => okCmd());
		await runVerb(t, 'mx.moveTo', { runId: 'm', pipetteId: 'p', x: 1, y: 2, z: 3 });
		expect(calls[0].body.data.params).toEqual({ pipetteId: 'p', coordinates: { x: 1, y: 2, z: 3 }, forceDirect: true });
	});
	it('home sends the explicit full axis set and a 60s robot hold', async () => {
		const { t, calls } = robot(() => okCmd());
		await runVerb(t, 'mx.home', { runId: 'm' });
		expect(calls[0].body.data.params.axes).toEqual(['x', 'y', 'leftZ', 'rightZ', 'leftPlunger', 'rightPlunger']);
		expect(calls[0].path).toContain('timeout=60000');
	});
	it('position returns {position}; missing position → 502', async () => {
		const good = robot(() => okCmd({ position: { x: 1, y: 2, z: 3 } }));
		expect(await runVerb(good.t, 'mx.position', { runId: 'm', pipetteId: 'p' })).toEqual({ status: 200, body: { position: { x: 1, y: 2, z: 3 } } });
		const bad = robot(() => okCmd({}));
		expect(await runVerb(bad.t, 'mx.position', { runId: 'm', pipetteId: 'p' })).toEqual({ status: 502, body: { message: 'Robot did not return a position' } });
	});
	it('drop-tip with no tip modelled → 200 {dropped:false}', async () => {
		const { t } = robot(() => res(201, { data: { status: 'failed', error: { detail: 'Pipette does not have a tip' } } }));
		const r = await runVerb(t, 'mx.dropTip', { runId: 'm', pipetteId: 'p' });
		expect(r.status).toBe(200);
		expect(r.body).toMatchObject({ dropped: false });
	});
});

describe('verbRoute / browserTransport', () => {
	it('maps verbs onto the existing BIMS routes', () => {
		expect(verbRoute('run.get', { rid: 'r' })).toEqual({ method: 'GET', path: '/runs/r' });
		expect(verbRoute('run.action', { rid: 'r' })).toEqual({ method: 'POST', path: '/runs/r/actions' });
		expect(verbRoute('mx.moveToWell', { runId: 'm' })).toEqual({ method: 'POST', path: '/maintenance/m/move-to-well' });
		expect(verbRoute('mx.dropTip', { runId: 'm' })).toEqual({ method: 'POST', path: '/maintenance/m/drop-tip' });
	});
	it('browser transport sends the same opentrons-version header robotFetch does', async () => {
		const seen: any[] = [];
		const f = (async (url: any, init: any) => {
			seen.push({ url, init });
			return res(200, {});
		}) as typeof fetch;
		const t = browserTransport('https://ot2-b14.tailf65a70.ts.net/', f);
		await t.post('/runs/r/actions', { a: 1 });
		expect(seen[0].url).toBe('https://ot2-b14.tailf65a70.ts.net/runs/r/actions');
		expect(seen[0].init.headers).toEqual({ 'Content-Type': 'application/json', 'opentrons-version': '3' });
		expect(seen[0].init.body).toBe('{"a":1}');
	});
});
