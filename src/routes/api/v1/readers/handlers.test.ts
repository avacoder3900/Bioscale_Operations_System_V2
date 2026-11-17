import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The /api/v1/readers handlers against an in-memory `spus` stand-in, a mocked
 * Particle client and the real spu-wifi functions over it (wrapped in spies).
 * No database, no device.
 */

const CONSUMER = 'consumer-key-0123456789abcdef';
const ME = 'h_AAAAAAAAAAAAAAAAAAAAAAAA';
const OTHER = 'h_BBBBBBBBBBBBBBBBBBBBBBBB';
const LABEL = '0c42168a-d868-401a-ac94-1b990f4ad10d';
const PASSWORD = 'Pw-7f3c9e1d-very-secret';
const SSID = 'Home Net 5G';

const state = vi.hoisted(() => ({
	spus: [] as any[],
	audits: [] as any[],
	updates: [] as { filter: any; update: any; opts: any }[],
	limited: [] as string[],
	device: { online: true, connected: true, firmware_version: 109 } as any,
	deviceThrows: null as null | Error,
	variables: {} as Record<string, unknown>,
	functions: {} as Record<string, number | Error>,
	calls: [] as { fn: string; arg: string }[],
	beforeUpdate: null as null | (() => void)
}));

const get = (o: any, path: string) => path.split('.').reduce((v, k) => (v == null ? undefined : v[k]), o);
function matches(doc: any, filter: Record<string, any>): boolean {
	return Object.entries(filter).every(([path, want]) => {
		if (path === '$or') return (want as any[]).some((f) => matches(doc, f));
		const have = get(doc, path);
		if (want && typeof want === 'object' && '$exists' in want) return (have !== undefined && have !== null) === want.$exists;
		if (want && typeof want === 'object' && '$in' in want) return want.$in.includes(have);
		return have === want;
	});
}

vi.mock('$env/dynamic/private', () => ({ env: { BIMS_API_KEY_CONSUMER: 'consumer-key-0123456789abcdef' } }));

vi.mock('$lib/server/db', () => {
	let n = 0;
	const q = (rows: () => any[]) => {
		const chain: any = { select: () => chain, limit: () => chain, lean: async () => structuredClone(rows()) };
		return chain;
	};
	return {
		connectDB: vi.fn(async () => {}),
		generateId: () => `id${++n}`,
		AuditLog: { create: vi.fn(async (row: any) => { state.audits.push(structuredClone(row)); }) },
		Spu: {
			find: (filter: any) => q(() => state.spus.filter((s) => matches(s, filter))),
			updateOne: vi.fn(async (filter: any, update: any, opts: any) => {
				state.beforeUpdate?.();
				state.beforeUpdate = null;
				state.updates.push(structuredClone({ filter, update, opts }));
				const doc = state.spus.find((s) => matches(s, filter));
				if (!doc) return { matchedCount: 0 };
				for (const [k, v] of Object.entries(update.$set ?? {})) doc[k] = v;
				for (const k of Object.keys(update.$unset ?? {})) delete doc[k];
				for (const [k, v] of Object.entries(update.$push ?? {})) (doc[k] ??= []).push(v);
				return { matchedCount: 1 };
			})
		}
	};
});

vi.mock('$lib/server/particle', () => ({
	getDevice: vi.fn(async () => {
		if (state.deviceThrows) throw state.deviceThrows;
		return state.device;
	}),
	getVariable: vi.fn(async (_id: string, name: string) => {
		const v = state.variables[name];
		if (v instanceof Error) throw v;
		if (v === undefined) throw new Error('Variable not found');
		return { result: v };
	}),
	callFunction: vi.fn(async (_id: string, fn: string, arg: string) => {
		state.calls.push({ fn, arg });
		const rv = state.functions[fn];
		if (rv instanceof Error) throw rv;
		return { return_value: rv ?? 1 };
	})
}));

vi.mock('$lib/server/spu-wifi', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/spu-wifi')>();
	return {
		...actual,
		readWifi: vi.fn(actual.readWifi),
		requestScan: vi.fn(actual.requestScan),
		replaceAndSwitch: vi.fn(actual.replaceAndSwitch)
	};
});

vi.mock('$lib/server/bims-api/rate-limit', async () => {
	const { ApiError } = await import('$lib/server/bims-api/http');
	return {
		enforceRateLimit: vi.fn(async (endpoint: string) => {
			if (state.limited.includes(endpoint)) throw new ApiError(429, 'Too many requests', { 'retry-after': '30' });
		})
	};
});

import { POST as pair } from './pair/+server';
import { GET as reader } from './[serial]/+server';
import { POST as unpair } from './[serial]/unpair/+server';
import { GET as wifiGet, POST as wifiPost } from './[serial]/wifi/+server';
import { enforceRateLimit } from '$lib/server/bims-api/rate-limit';
import { replaceAndSwitch, requestScan } from '$lib/server/spu-wifi';

const SERIAL = 'BT-M01-0000-0230';
const STATUS = JSON.stringify({ v: 1, fw: 109, on: 1, ready: 1, ssid: 'Old', rssi: -50, cloud: 1, cell: 1, sw: 0, swseq: 0, scanseq: 3, saved: ['Old'] });
const SCAN = JSON.stringify({ v: 1, seq: 3, fw: 109, n: [[SSID, -40, 3, 6]], more: 0 });

const released = (over: any = {}) => ({
	_id: 'spu230',
	udi: SERIAL,
	barcode: LABEL,
	status: 'released',
	assignment: { type: 'customer', customer: { _id: 'c1', name: 'Brevitest Research' } },
	particleLink: { particleDeviceId: 'dev230', particleSerial: 'P2MABA1234ABCD' },
	...over
});
const held = (ref = ME, over: any = {}) => released({ holder: { kind: 'app', ref, via: 'bioscale-app', since: new Date('2026-11-17T10:00:00Z') }, ...over });

type Call = { key?: string | null; query?: string; body?: unknown; serial?: string };

async function call(handler: any, method: 'GET' | 'POST', path: string, c: Call = {}) {
	const serial = c.serial ?? SERIAL;
	const url = new URL(`https://bims.test/api/v1/readers${path.replace('{serial}', serial)}${c.query ?? ''}`);
	const headers: Record<string, string> = {};
	if (c.key !== null) headers.authorization = `Bearer ${c.key ?? CONSUMER}`;
	const request = new Request(url, {
		method,
		headers,
		...(method === 'POST' ? { body: typeof c.body === 'string' ? c.body : JSON.stringify(c.body ?? {}) } : {})
	});
	const res: Response = await handler({ request, url, params: { serial } });
	return { status: res.status, body: await res.json(), headers: res.headers };
}

const doPair = (body: unknown, c: Call = {}) => call(pair, 'POST', '/pair', { ...c, body });
const doUnpair = (body: unknown, c: Call = {}) => call(unpair, 'POST', '/{serial}/unpair', { ...c, body });
const doReader = (c: Call = {}) => call(reader, 'GET', '/{serial}', { query: `?holderRef=${ME}`, ...c });
const doWifiGet = (c: Call = {}) => call(wifiGet, 'GET', '/{serial}/wifi', { query: `?holderRef=${ME}`, ...c });
const doWifiPost = (body: unknown, c: Call = {}) => call(wifiPost, 'POST', '/{serial}/wifi', { ...c, body });

beforeEach(() => {
	state.spus = [released()];
	state.audits = [];
	state.updates = [];
	state.limited = [];
	state.device = { online: true, connected: true, firmware_version: 109 };
	state.deviceThrows = null;
	state.variables = { wifi_status: STATUS, wifi_scan: SCAN };
	state.functions = { get_state: 0, set_service: 7, set_wifi_credentials: 12 };
	state.calls = [];
	state.beforeUpdate = null;
	vi.clearAllMocks();
	vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('auth and input', () => {
	it('401 without or with a wrong key, on every endpoint', async () => {
		for (const r of [
			await doPair({ holderRef: ME, code: SERIAL }, { key: null }),
			await doUnpair({ holderRef: ME }, { key: 'wrong-key-0123456789abcdefgh' }),
			await doReader({ key: null }),
			await doWifiGet({ key: null }),
			await doWifiPost({ holderRef: ME, action: 'scan' }, { key: null })
		]) {
			expect(r.status).toBe(401);
			expect(r.body).toEqual({ message: 'Invalid or missing API key' });
		}
	});
	it('400 for a bad holderRef, a missing or long code, extra fields, a bad serial, an unknown action', async () => {
		expect((await doPair({ holderRef: 'acct_1', code: SERIAL })).status).toBe(400);
		expect((await doPair({ holderRef: ME })).body).toEqual({ message: 'code is required (at most 200 characters)' });
		expect((await doPair({ holderRef: ME, code: 'x'.repeat(201) })).status).toBe(400);
		expect((await doPair({ holderRef: ME, code: SERIAL, email: 'a@b.c' })).body).toEqual({
			message: 'Only holderRef and code are accepted in the body'
		});
		expect((await doReader({ serial: 'bad serial!' })).body).toEqual({ message: 'Not a reader serial' });
		expect((await doReader({ query: '' })).status).toBe(400);
		expect((await doWifiPost({ holderRef: ME, action: 'reboot' })).body).toEqual({ message: 'Unknown action' });
		expect(state.updates).toHaveLength(0);
	});
	it('responses are JSON and no-store', async () => {
		const r = await doPair({ holderRef: ME, code: SERIAL });
		expect(r.headers.get('content-type')).toBe('application/json');
		expect(r.headers.get('cache-control')).toBe('no-store');
	});
	it('429 from the limiter, with the right endpoint names', async () => {
		state.limited = ['reader_pair'];
		const r = await doPair({ holderRef: ME, code: SERIAL });
		expect(r.status).toBe(429);
		expect(r.headers.get('retry-after')).toBe('30');
		state.limited = [];
		await doWifiPost({ holderRef: ME, action: 'scan' });
		await doWifiPost({ holderRef: ME, action: 'connect', ssid: SSID, password: PASSWORD, security: 3 });
		await doWifiGet();
		await doReader();
		const names = vi.mocked(enforceRateLimit).mock.calls.map((c) => [c[0], c[1], c[2]]);
		expect(names).toEqual([
			['reader_pair', 'bioscale-app', ME],
			['reader_scan', 'bioscale-app', ME],
			['reader_connect', 'bioscale-app', ME],
			['reader_wifi', 'bioscale-app', ME],
			['reader_get', 'bioscale-app', ME]
		]);
	});
});

describe('POST /readers/pair', () => {
	it('201 paired by UDI: writes holder, one journal entry and one audit row; assignment untouched', async () => {
		const r = await doPair({ holderRef: ME, code: 'bt-m01-0000-0230' });
		expect(r.status).toBe(201);
		expect(r.body).toMatchObject({ ok: true, status: 'paired', reader: { serial: SERIAL, online: true, firmware: 109, wifiSupported: true } });
		expect(typeof r.body.reader.since).toBe('string');
		const doc = state.spus[0];
		expect(doc.holder).toMatchObject({ kind: 'app', ref: ME, via: 'bioscale-app' });
		expect(doc.holder.since).toBeInstanceOf(Date);
		expect(doc.assignment).toEqual({ type: 'customer', customer: { _id: 'c1', name: 'Brevitest Research' } });
		expect(doc.journal).toHaveLength(1);
		expect(doc.journal[0].text).toBe(`Paired with a Bioscale app (bioscale-app, holder ${ME})`);
		expect(state.updates[0].opts).toEqual({ allowFinalized: true });
		expect(Object.keys(state.updates[0].update.$set)).toEqual(['holder']);
		expect(state.audits).toHaveLength(1);
		expect(state.audits[0]).toMatchObject({ tableName: 'spus', recordId: 'spu230', action: 'PAIR', changedBy: 'api:bioscale-app' });
		expect(state.audits[0].newData.holder).toEqual({ kind: 'app', ref: ME, via: 'bioscale-app' });
	});
	it('accepts the QR label, a URL around it and the Particle serial', async () => {
		for (const code of [LABEL.toUpperCase(), `https://bioscale.app/pair?code=${LABEL}`, 'P2MABA1234ABCD']) {
			state.spus = [released()];
			expect((await doPair({ holderRef: ME, code })).status).toBe(201);
		}
	});
	it('200 already for the same holder; nothing written', async () => {
		state.spus = [held()];
		const r = await doPair({ holderRef: ME, code: SERIAL });
		expect(r.status).toBe(200);
		expect(r.body).toMatchObject({ ok: true, status: 'already', reader: { serial: SERIAL, since: '2026-11-17T10:00:00.000Z' } });
		expect(state.updates).toHaveLength(0);
		expect(state.audits).toHaveLength(0);
	});
	it('409 held_by_other', async () => {
		state.spus = [held(OTHER)];
		const r = await doPair({ holderRef: ME, code: SERIAL });
		expect(r).toMatchObject({ status: 409, body: { ok: false, reason: 'held_by_other' } });
		expect(state.updates).toHaveLength(0);
	});
	it.each(['draft', 'assembling', 'validating', 'servicing', 'retired'])('409 not_available when %s', async (status) => {
		state.spus = [released({ status })];
		const r = await doPair({ holderRef: ME, code: SERIAL });
		expect(r).toMatchObject({ status: 409, body: { ok: false, reason: 'not_available' } });
		expect(state.updates).toHaveLength(0);
	});
	it('404 not_found for an unknown code', async () => {
		const r = await doPair({ holderRef: ME, code: 'BT-M01-0000-9999' });
		expect(r).toEqual(expect.objectContaining({ status: 404, body: { ok: false, reason: 'not_found' } }));
	});
	it('another holder pairing in between: the write misses, the re-read says held_by_other', async () => {
		state.beforeUpdate = () => {
			state.spus[0].holder = { kind: 'app', ref: OTHER, via: 'bioscale-business', since: new Date() };
		};
		const r = await doPair({ holderRef: ME, code: SERIAL });
		expect(r).toMatchObject({ status: 409, body: { reason: 'held_by_other' } });
		expect(state.spus[0].holder.ref).toBe(OTHER);
		expect(state.audits).toHaveLength(0);
	});
	it('Particle down: still 201, with nulls', async () => {
		state.deviceThrows = new Error('Particle API error: 503');
		const r = await doPair({ holderRef: ME, code: SERIAL });
		expect(r.status).toBe(201);
		expect(r.body.reader).toMatchObject({ online: null, firmware: null, wifiSupported: null });
	});
	it('offline reader: firmware from Particle, wifiSupported inferred from it', async () => {
		state.device = { online: false, connected: false, firmware_version: 103 };
		const r = await doPair({ holderRef: ME, code: SERIAL });
		expect(r.body.reader).toMatchObject({ online: false, firmware: 103, wifiSupported: false });
	});
	it('online reader without the wifi_status variable: wifiSupported false', async () => {
		state.device = { online: true, connected: true, firmware_version: 103 };
		delete state.variables.wifi_status;
		const r = await doPair({ holderRef: ME, code: SERIAL });
		expect(r.body.reader).toMatchObject({ online: true, firmware: 103, wifiSupported: false });
	});
	it('no Particle device linked: nulls', async () => {
		state.spus = [released({ particleLink: {} })];
		const r = await doPair({ holderRef: ME, code: SERIAL });
		expect(r.body.reader).toEqual({ serial: SERIAL, online: null, firmware: null, wifiSupported: null, since: expect.any(String) });
	});
});

describe('POST /readers/{serial}/unpair', () => {
	it('200 unpaired: removes holder, journals and audits', async () => {
		state.spus = [held()];
		const r = await doUnpair({ holderRef: ME });
		expect(r).toMatchObject({ status: 200, body: { ok: true, status: 'unpaired' } });
		expect(state.spus[0].holder).toBeUndefined();
		expect(state.spus[0].assignment).toBeDefined();
		expect(state.spus[0].journal[0].text).toBe(`Unpaired from a Bioscale app (bioscale-app, holder ${ME})`);
		expect(state.audits[0]).toMatchObject({ action: 'UNPAIR', newData: { holder: null } });
	});
	it('200 not_paired when no one holds it', async () => {
		expect((await doUnpair({ holderRef: ME })).body).toEqual({ ok: true, status: 'not_paired' });
		expect(state.updates).toHaveLength(0);
	});
	it('409 held_by_other', async () => {
		state.spus = [held(OTHER)];
		expect(await doUnpair({ holderRef: ME })).toMatchObject({ status: 409, body: { ok: false, reason: 'held_by_other' } });
		expect(state.spus[0].holder.ref).toBe(OTHER);
	});
	it('404 not_found', async () => {
		expect(await doUnpair({ holderRef: ME }, { serial: 'BT-M01-0000-9999' })).toMatchObject({
			status: 404,
			body: { ok: false, reason: 'not_found' }
		});
	});
	it('only holderRef in the body', async () => {
		state.spus = [held()];
		expect((await doUnpair({ holderRef: ME, reason: 'sold it' })).status).toBe(400);
	});
});

describe('GET /readers/{serial}', () => {
	it('200 ReaderView for the holder, serial any case', async () => {
		state.spus = [held()];
		const r = await doReader({ serial: 'bt-m01-0000-0230' });
		expect(r.status).toBe(200);
		expect(r.body).toEqual({ serial: SERIAL, online: true, firmware: 109, wifiSupported: true, since: '2026-11-17T10:00:00.000Z' });
	});
	it('404 for another holder, an unheld reader and an unknown serial, all alike', async () => {
		state.spus = [held(OTHER)];
		const other = await doReader();
		state.spus = [released()];
		const unheld = await doReader();
		const unknown = await doReader({ serial: 'BT-M01-0000-9999' });
		for (const r of [other, unheld, unknown]) expect(r).toMatchObject({ status: 404, body: { reason: 'not_found' } });
	});
});

describe('GET /readers/{serial}/wifi', () => {
	it('200 the operator shape, from readWifi', async () => {
		state.spus = [held()];
		const r = await doWifiGet();
		expect(r.status).toBe(200);
		expect(r.body).toMatchObject({ online: true, supported: true, error: null, status: { ssid: 'Old', cellular: true, firmware: 109 }, scan: { seq: 3 } });
		expect(r.body.scan.networks[0]).toMatchObject({ ssid: SSID, securityLabel: 'WPA2', supported: true });
		expect(state.updates).toHaveLength(0);
		expect(state.audits).toHaveLength(0);
	});
	it('offline: online false, the rest null', async () => {
		state.spus = [held()];
		state.device = { online: false, connected: false };
		expect((await doWifiGet()).body).toEqual({ online: false, supported: null, status: null, scan: null, error: null });
	});
	it('old firmware: supported false', async () => {
		state.spus = [held()];
		state.variables = {};
		expect((await doWifiGet()).body).toMatchObject({ online: true, supported: false, status: null, scan: null });
	});
	it('404 unless held by this holder', async () => {
		state.spus = [held(OTHER)];
		expect(await doWifiGet()).toMatchObject({ status: 404, body: { reason: 'not_found' } });
		state.spus = [released()];
		expect(await doWifiGet()).toMatchObject({ status: 404, body: { reason: 'not_found' } });
	});
});

describe('POST /readers/{serial}/wifi', () => {
	beforeEach(() => {
		state.spus = [held()];
	});

	it('scan: 200 { seq } through requestScan', async () => {
		const r = await doWifiPost({ holderRef: ME, action: 'scan' });
		expect(r).toMatchObject({ status: 200, body: { seq: 7 } });
		expect(requestScan).toHaveBeenCalledWith('dev230');
		expect(state.calls).toEqual([{ fn: 'set_service', arg: 'wifi_scan' }]);
		expect(state.updates).toHaveLength(0);
	});
	it('scan refused: 409 in reader wording', async () => {
		state.functions.set_service = -2;
		const r = await doWifiPost({ holderRef: ME, action: 'scan' });
		expect(r.status).toBe(409);
		expect(r.body.error).toBe('The reader is busy (running a test or other routine). Try again when it is idle.');
	});
	it('scan unreachable: 502', async () => {
		state.functions.set_service = new Error('Device is not connected');
		expect(await doWifiPost({ holderRef: ME, action: 'scan' })).toMatchObject({ status: 502, body: { error: 'Could not reach the reader.' } });
	});
	it('404 unless held by this holder; nothing sent to the device', async () => {
		state.spus = [held(OTHER)];
		expect((await doWifiPost({ holderRef: ME, action: 'scan' })).status).toBe(404);
		expect((await doWifiPost({ holderRef: ME, action: 'connect', ssid: SSID, password: PASSWORD, security: 3 })).status).toBe(404);
		expect(state.calls).toHaveLength(0);
	});
	it('connect: 200 { seq } through replaceAndSwitch; journal and audit without the network name', async () => {
		const r = await doWifiPost({ holderRef: ME, action: 'connect', ssid: SSID, password: PASSWORD, security: 3 });
		expect(r).toMatchObject({ status: 200, body: { seq: 12 } });
		expect(replaceAndSwitch).toHaveBeenCalledWith('dev230', SSID, PASSWORD, 3);
		expect(state.calls.map((c) => c.fn)).toEqual(['get_state', 'set_wifi_credentials', 'set_wifi_credentials']);
		expect(state.spus[0].journal.map((j: any) => j.text)).toEqual(['Wi-Fi changed from a Bioscale app (bioscale-app)']);
		expect(state.audits).toHaveLength(1);
		const written = JSON.stringify([state.updates, state.audits]);
		expect(written).not.toContain(SSID);
		expect(written).not.toContain(PASSWORD);
	}, 10_000);
	it('connect: 400 from validateCredentials', async () => {
		const r = await doWifiPost({ holderRef: ME, action: 'connect', ssid: SSID, password: 'short', security: 3 });
		expect(r).toMatchObject({ status: 400, body: { error: 'WPA passwords are 8–63 characters.' } });
		expect(state.calls).toHaveLength(0);
	});
	it('connect: 409 when cellular is down or the reader is busy, in reader wording', async () => {
		state.variables.wifi_status = JSON.stringify({ ...JSON.parse(STATUS), cell: 0 });
		const noCell = await doWifiPost({ holderRef: ME, action: 'connect', ssid: SSID, password: PASSWORD, security: 3 });
		expect(noCell.status).toBe(409);
		expect(noCell.body.error).toBe('Cellular is not connected on this reader, so switching Wi-Fi could leave it unreachable.');
		state.variables.wifi_status = STATUS;
		state.functions.get_state = 5;
		const busy = await doWifiPost({ holderRef: ME, action: 'connect', ssid: SSID, password: PASSWORD, security: 3 });
		expect(busy).toMatchObject({ status: 409, body: { error: 'The reader is busy (running a test or other routine). Try again when it is idle.' } });
		expect(state.calls.some((c) => c.fn === 'set_wifi_credentials')).toBe(false);
		expect(state.audits).toHaveLength(0);
	});
	it('connect: 409 old firmware', async () => {
		state.variables = {};
		const r = await doWifiPost({ holderRef: ME, action: 'connect', ssid: SSID, password: PASSWORD, security: 3 });
		expect(r).toMatchObject({ status: 409, body: { error: 'This reader runs firmware older than v109.' } });
	});
	it('connect: 502 when replaceAndSwitch throws', async () => {
		vi.mocked(replaceAndSwitch).mockRejectedValueOnce(new Error(`network down while sending ${PASSWORD}`));
		const r = await doWifiPost({ holderRef: ME, action: 'connect', ssid: SSID, password: PASSWORD, security: 3 });
		expect(r).toMatchObject({ status: 502, body: { error: 'Could not reach the reader.' } });
	});
});

describe('the password never leaks', () => {
	it('appears in no response, journal, audit, update or log line, whatever the device answers', async () => {
		const bodies: unknown[] = [];
		const run = async () => {
			bodies.push((await doWifiPost({ holderRef: ME, action: 'connect', ssid: SSID, password: PASSWORD, security: 3 })).body);
		};
		state.spus = [held()];

		// Success.
		await run();
		// The device refuses the credentials.
		state.functions.set_wifi_credentials = -5;
		await run();
		// Particle throws an error that (worst case) echoes the argument it was sent.
		state.functions.set_wifi_credentials = new Error(`Bad arg ${SSID}:::${PASSWORD}:::3`);
		await run();
		// The whole call throws with the password in its message.
		vi.mocked(replaceAndSwitch).mockRejectedValueOnce(new Error(`boom ${PASSWORD}`));
		await run();
		// Validation failure with the password present (open network given a password).
		bodies.push((await doWifiPost({ holderRef: ME, action: 'connect', ssid: SSID, password: PASSWORD, security: 0 })).body);
		// A thrown error inside the guarded handler is logged by class only.
		vi.mocked(replaceAndSwitch).mockImplementationOnce(() => {
			throw new TypeError(`sync ${PASSWORD}`);
		});
		await run();

		expect(bodies).toHaveLength(6);
		const everything = JSON.stringify({
			bodies,
			audits: state.audits,
			updates: state.updates,
			journal: state.spus[0].journal ?? [],
			logs: vi.mocked(console.error).mock.calls
		});
		expect(everything).not.toContain(PASSWORD);
		expect(JSON.stringify({ audits: state.audits, journal: state.spus[0].journal ?? [] })).not.toContain(SSID);
		// But the device did receive it.
		expect(state.calls.some((c) => c.fn === 'set_wifi_credentials' && c.arg === `${SSID}:::${PASSWORD}:::3`)).toBe(true);
	}, 30_000);
});
