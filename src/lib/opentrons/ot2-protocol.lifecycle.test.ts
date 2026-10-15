/**
 * Option 1 of OT2-TAILNET-4: the maintenance-run lifecycle + labware verbs,
 * moved out of maintenance.ts and the open/close/load-labware/pick-up-tip
 * routes. Same behaviour the routes had; the BIMS half is `maintenanceRecordFor`.
 */
import { describe, it, expect } from 'vitest';
import { runVerb, maintenanceRecordFor, type Ot2Transport } from './ot2-protocol';

type Call = { method: 'GET' | 'POST' | 'DELETE'; path: string; body?: any };

function robot(respond: (c: Call) => Response | Promise<Response>) {
	const calls: Call[] = [];
	const push = (c: Call) => {
		calls.push(c);
		return respond(c);
	};
	const t: Ot2Transport = {
		get: async (path) => push({ method: 'GET', path }),
		post: async (path, body) => push({ method: 'POST', path, body }),
		delete: async (path) => push({ method: 'DELETE', path })
	};
	return { t, calls };
}
const res = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const okCmd = (result: unknown = {}) => res(201, { data: { status: 'succeeded', result } });
const DEF = { namespace: 'custom_beta', version: 3 };

describe('mx.open', () => {
	it('discovers the pipette (preferred mount), opens the run, loads the pipette', async () => {
		const { t, calls } = robot((c) => {
			if (c.path === '/pipettes') return res(200, { left: { name: 'p300_single_gen2' }, right: { name: 'p20_single_gen2' } });
			if (c.path === '/maintenance_runs') return res(201, { data: { id: 'm9' } });
			return okCmd({ pipetteId: 'pip-1' });
		});
		const r = await runVerb(t, 'mx.open', { mount: 'right' });
		expect(r).toEqual({ status: 200, body: { runId: 'm9', pipetteId: 'pip-1', pipetteName: 'p20_single_gen2', mount: 'right' } });
		expect(calls.map((c) => `${c.method} ${c.path.split('?')[0]}`)).toEqual([
			'GET /pipettes',
			'POST /maintenance_runs',
			'POST /maintenance_runs/m9/commands'
		]);
		expect(maintenanceRecordFor('mx.open', {}, r)).toEqual({
			event: 'maintenance_run_open',
			runId: 'm9',
			pipetteId: 'pip-1',
			pipetteName: 'p20_single_gen2',
			mount: 'right'
		});
	});

	it('never kills an ACTIVE protocol run that blocks it', async () => {
		const { t, calls } = robot((c) => {
			if (c.path === '/pipettes') return res(200, {});
			if (c.path === '/maintenance_runs') return res(409, { errors: [{ detail: 'A protocol run is active' }] });
			if (c.path === '/runs') return res(200, { links: { current: { href: '/runs/r1' } }, data: [{ id: 'r1', status: 'running' }] });
			return res(200, {});
		});
		const r = await runVerb(t, 'mx.open', {});
		expect(r.status).toBe(502);
		expect((r.body as any).message).toContain('ACTIVE protocol run');
		expect(calls.some((c) => c.path.includes('/actions') || c.method === 'DELETE')).toBe(false);
		expect(maintenanceRecordFor('mx.open', {}, r)).toBeNull();
	});
});

describe('mx.close', () => {
	it('DELETEs the run; an already-gone run (404) is fine', async () => {
		const { t, calls } = robot(() => res(404, {}));
		const r = await runVerb(t, 'mx.close', { runId: 'm1' });
		expect(r).toEqual({ status: 200, body: { ok: true } });
		expect(calls[0]).toMatchObject({ method: 'DELETE', path: '/maintenance_runs/m1' });
		expect(maintenanceRecordFor('mx.close', { runId: 'm1' }, r)).toEqual({ event: 'maintenance_run_close', runId: 'm1' });
	});
});

describe('mx.loadLabware', () => {
	const args = { runId: 'm1', loadName: 'deck', slot: '1', definition: DEF, labwareNamespace: 'custom_beta', labwareVersion: 3 };

	it('registers the definition and loads with the identity BIMS resolved', async () => {
		const { t, calls } = robot((c) =>
			c.method === 'GET' ? res(200, { data: { labware: [] } }) : c.path.endsWith('labware_definitions') ? res(201, {}) : okCmd({ labwareId: 'lw1' })
		);
		const r = await runVerb(t, 'mx.loadLabware', args);
		expect(r).toEqual({ status: 200, body: { labwareId: 'lw1' } });
		expect(calls[0]).toMatchObject({ method: 'POST', path: '/maintenance_runs/m1/labware_definitions', body: { data: DEF } });
		expect(calls[2].body.data.params).toEqual({ location: { slotName: '1' }, loadName: 'deck', namespace: 'custom_beta', version: 3 });
	});

	it('hardened robot refuses a stale version in the slot; a legacy robot reuses it', async () => {
		const handler = (c: Call) =>
			c.method === 'GET'
				? res(200, { data: { labware: [{ id: 'old', loadName: 'deck', definitionUri: 'custom_beta/deck/2', location: { slotName: '1' } }] } })
				: res(201, {});
		expect(await runVerb(robot(handler).t, 'mx.loadLabware', { ...args, hardened: false })).toEqual({ status: 200, body: { labwareId: 'old' } });
		const hard = await runVerb(robot(handler).t, 'mx.loadLabware', { ...args, hardened: true });
		expect(hard.status).toBe(502);
		expect((hard.body as any).message).toContain('custom_beta/deck/3');
	});

	it('refuses to touch the robot without a BIMS-resolved definition', async () => {
		const { t, calls } = robot(() => res(200, {}));
		expect((await runVerb(t, 'mx.loadLabware', { runId: 'm1', loadName: 'deck' })).status).toBe(400);
		expect(calls).toHaveLength(0);
	});
});

describe('mx.pickUpTip', () => {
	it('tip already on → 409 TIP_ALREADY_ATTACHED and no cursor advance', async () => {
		const { t } = robot((c) => {
			if (c.method === 'GET') return res(200, { data: { labware: [] } });
			if (c.path.endsWith('labware_definitions')) return res(201, {});
			if (c.body?.data?.commandType === 'loadLabware') return okCmd({ labwareId: 'rack' });
			return res(201, { data: { status: 'failed', error: { detail: 'Pipette should not have a tip' } } });
		});
		const r = await runVerb(t, 'mx.pickUpTip', { runId: 'm1', pipetteId: 'p', tiprackLoadName: 'tiprack20', tipWell: 'B1', definition: DEF });
		expect(r).toMatchObject({ status: 409, body: { code: 'TIP_ALREADY_ATTACHED', tiprackLabwareId: 'rack' } });
		expect(maintenanceRecordFor('mx.pickUpTip', { tiprackLoadName: 'tiprack20' }, r)).toBeNull();
	});

	it('another rack in the slot → 409 SLOT_OCCUPIED', async () => {
		const { t } = robot((c) =>
			c.method === 'GET' ? res(200, { data: { labware: [{ id: 'x', loadName: 'reagent_rack', location: { slotName: '11' } }] } }) : res(201, {})
		);
		const r = await runVerb(t, 'mx.pickUpTip', { runId: 'm1', pipetteId: 'p', tiprackLoadName: 'tiprack20', definition: DEF });
		expect(r).toMatchObject({ status: 409, body: { code: 'SLOT_OCCUPIED' } });
	});

	it('success → tiprackLabwareId, and the cursor advance is the BIMS half', async () => {
		const { t } = robot((c) =>
			c.method === 'GET' ? res(200, { data: { labware: [] } }) : c.path.endsWith('labware_definitions') ? res(201, {}) : okCmd({ labwareId: 'rack' })
		);
		const r = await runVerb(t, 'mx.pickUpTip', { runId: 'm1', pipetteId: 'p', tiprackLoadName: 'tiprack20', tipWell: 'C2', definition: DEF });
		expect(r).toEqual({ status: 200, body: { tiprackLabwareId: 'rack' } });
		expect(maintenanceRecordFor('mx.pickUpTip', { tiprackLoadName: 'tiprack20', tipWell: 'C2' }, r)).toEqual({
			event: 'studio_tip_pickup',
			tiprackLoadName: 'tiprack20',
			tipWell: 'C2'
		});
	});
});
