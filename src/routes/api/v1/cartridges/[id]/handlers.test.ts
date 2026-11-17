import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The four /api/v1 handlers against in-memory stand-ins for the models they
 * touch. No database: `$lib/server/db` and the rate-limit counter are mocked.
 */

const CONSUMER = 'consumer-key-0123456789abcdef';
const BUSINESS = 'business-key-0123456789abcdef';
const AGENT = 'agent-key-0123456789abcdef-zz';
const LEGACY_CONSUMER = 'legacy-consumer-key-0123456789';

const state = vi.hoisted(() => ({
	docs: new Map<string, any>(),
	qcIds: new Set<string>(),
	audits: [] as any[],
	updates: [] as { filter: any; update: any }[],
	spus: [] as any[],
	limited: false,
	/** Runs once, between a link's read and its write. */
	beforeUpdate: null as null | (() => void)
}));

const get = (o: any, path: string) => path.split('.').reduce((v, k) => (v == null ? undefined : v[k]), o);
const set = (o: any, path: string, value: unknown) => {
	const keys = path.split('.');
	const last = keys.pop()!;
	const parent = keys.reduce((v, k) => (v[k] ??= {}), o);
	if (value === undefined) delete parent[last];
	else parent[last] = value;
};
const matches = (doc: any, filter: Record<string, any>) =>
	Object.entries(filter).every(([path, want]) => {
		const have = get(doc, path);
		if (want && typeof want === 'object' && '$exists' in want) return (have !== undefined) === want.$exists;
		if (want === null) return have === undefined || have === null;
		return have === want;
	});

vi.mock('$env/dynamic/private', () => ({
	env: {
		BIMS_API_KEY_CONSUMER: 'consumer-key-0123456789abcdef',
		BIMS_API_KEY_BUSINESS: 'business-key-0123456789abcdef',
		AGENT_API_KEY: 'agent-key-0123456789abcdef-zz',
		CONSUMER_API_KEY: 'legacy-consumer-key-0123456789'
	}
}));

vi.mock('$lib/server/db', () => ({
	connectDB: vi.fn(async () => {}),
	AuditLog: { create: vi.fn(async (row: any) => { state.audits.push(row); }) },
	ShippingLot: { exists: async (q: any) => (state.qcIds.has(q['qaqcReleases.qaqcCartridgeIds']) ? { _id: 'lot' } : null) },
	Spu: {
		findOne: (q: any) => ({
			select: () => ({ lean: async () => state.spus.find((s) => s.particleLink?.particleDeviceId === q['particleLink.particleDeviceId']) ?? null })
		})
	},
	CartridgeRecord: {
		// Mirrors the $project in service.ts: run data comes back as a presence flag.
		aggregate: async (pipeline: any[]) => {
			const doc = state.docs.get(pipeline[0].$match._id);
			if (!doc) return [];
			const { rawData, reading, ...rest } = structuredClone(doc);
			return [{ ...rest, ...(rawData !== undefined ? { rawData: true } : {}), ...(reading !== undefined ? { reading: true } : {}) }];
		},
		collection: {
			findOne: async (q: any) => structuredClone(state.docs.get(q._id) ?? null),
			updateOne: async (filter: any, update: any) => {
				state.beforeUpdate?.();
				state.beforeUpdate = null;
				state.updates.push({ filter, update });
				const doc = state.docs.get(filter._id);
				if (!doc || !matches(doc, filter)) return { matchedCount: 0 };
				for (const [k, v] of Object.entries(update.$set ?? {})) set(doc, k, v);
				for (const k of Object.keys(update.$unset ?? {})) set(doc, k, undefined);
				return { matchedCount: 1 };
			}
		}
	}
}));

vi.mock('$lib/server/bims-api/rate-limit', async () => {
	const { ApiError } = await import('$lib/server/bims-api/http');
	return {
		enforceRateLimit: vi.fn(async () => {
			if (state.limited) throw new ApiError(429, 'Too many requests', { 'retry-after': '30' });
		})
	};
});

import { GET as check } from './+server';
import { POST as link } from './link/+server';
import { POST as unlink } from './unlink/+server';
import { GET as result } from './result/+server';
import { enforceRateLimit } from '$lib/server/bims-api/rate-limit';

const ID = '3f6c1c1e-0a1b-4c2d-8e3f-9a8b7c6d5e4f';
const ME = 'h_AAAAAAAAAAAAAAAAAAAAAAAA';
const OTHER = 'h_BBBBBBBBBBBBBBBBBBBBBBBB';

const shipped = () => ({
	_id: ID,
	status: 'shipped',
	assayId: 'A56E0F5A',
	assayName: 'Cortisol - 6.1',
	reagentFilling: { fillLotId: 'fl1', fillLotNumber: 'FL-001', reagentLotId: 'rl1', reagentLotNumber: 'RL-001', expirationDate: new Date('2027-01-31T00:00:00Z') },
	// Things that must never come back:
	shipping: { customer: { _id: 'cust1', name: 'Jane Roe' }, contactEmail: 'jane@example.com' },
	sample: { subjectId: 'subj1' },
	sampleLabel: 'Calibrator 50'
});

type Call = { key?: string | null; query?: string; body?: unknown; id?: string; headers?: Record<string, string> };

async function call(handler: any, method: 'GET' | 'POST', path: string, c: Call = {}) {
	const id = c.id ?? ID;
	const url = new URL(`https://bims.test/api/v1/cartridges/${id}${path}${c.query ?? ''}`);
	const headers: Record<string, string> = { ...(c.headers ?? {}) };
	if (c.key !== null) headers.authorization = `Bearer ${c.key ?? CONSUMER}`;
	const request = new Request(url, {
		method,
		headers,
		body: method === 'POST' ? (typeof c.body === 'string' ? c.body : JSON.stringify(c.body ?? { holderRef: ME })) : undefined
	});
	const res: Response = await handler({ request, params: { id }, url });
	return { status: res.status, headers: res.headers, body: await res.json() };
}

beforeEach(() => {
	state.docs = new Map([[ID, shipped()]]);
	state.qcIds = new Set();
	state.audits = [];
	state.updates = [];
	state.spus = [];
	state.limited = false;
	state.beforeUpdate = null;
	vi.mocked(enforceRateLimit).mockClear();
});

describe('auth, validation and limits (every endpoint)', () => {
	const endpoints: [string, any, 'GET' | 'POST', string, string][] = [
		['check', check, 'GET', '', ''],
		['link', link, 'POST', '/link', ''],
		['unlink', unlink, 'POST', '/unlink', ''],
		['result', result, 'GET', '/result', `?holderRef=${ME}`]
	];

	it.each(endpoints)('%s: no key, a wrong key, the agent key and the legacy consumer key are all 401 JSON', async (_n, h, m, p, q) => {
		for (const key of [null, 'wrong-wrong-wrong-wrong-wrong-wrong', AGENT, LEGACY_CONSUMER]) {
			const r = await call(h, m, p, { key, query: q });
			expect(r.status).toBe(401);
			expect(r.body).toEqual({ message: 'Invalid or missing API key' });
			expect(r.headers.get('content-type')).toBe('application/json');
		}
		// The key in another route's header is not read.
		expect((await call(h, m, p, { key: null, query: q, headers: { 'x-consumer-api-key': CONSUMER, 'x-agent-api-key': CONSUMER } })).status).toBe(401);
		expect(state.updates).toHaveLength(0);
	});

	it.each(endpoints)('%s: a malformed cartridge id is 400', async (_n, h, m, p, q) => {
		const r = await call(h, m, p, { id: 'no', query: q });
		expect(r.status).toBe(400);
		expect(r.body).toEqual({ message: 'Not a cartridge id' });
	});

	it.each(endpoints)('%s: over the limit is 429 with Retry-After, before any work', async (_n, h, m, p, q) => {
		state.limited = true;
		const r = await call(h, m, p, { query: q });
		expect(r.status).toBe(429);
		expect(r.headers.get('retry-after')).toBe('30');
		expect(r.body).toEqual({ message: 'Too many requests' });
		expect(state.updates).toHaveLength(0);
	});

	it('the limiter is told the endpoint, the calling app and the holder, never the key', async () => {
		await call(link, 'POST', '/link', { key: BUSINESS });
		expect(vi.mocked(enforceRateLimit).mock.calls[0]).toEqual(['link', 'bioscale-business', ME]);
		await call(check, 'GET', '');
		expect(vi.mocked(enforceRateLimit).mock.calls[1]).toEqual(['check', 'bioscale-app', null]);
	});

	it.each([
		['missing', {}],
		['an email', { holderRef: 'jane@example.com' }],
		['an account id', { holderRef: 'google:1234567890123456' }],
		['too short', { holderRef: 'h_short' }],
		['not a string', { holderRef: 42 }],
		['with an extra field', { holderRef: ME, email: 'jane@example.com' }],
		['not an object', [ME]],
		['not JSON', 'holderRef=h_AAAA']
	])('link and unlink refuse a body whose holderRef is %s', async (_n, body) => {
		for (const [h, p] of [[link, '/link'], [unlink, '/unlink']] as const) {
			const r = await call(h, 'POST', p, { body });
			expect(r.status).toBe(400);
			expect(r.body).toHaveProperty('message');
		}
		expect(state.updates).toHaveLength(0);
	});

	it('an unexpected failure is a 500 that logs no id or holder', async () => {
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.mocked(enforceRateLimit).mockRejectedValueOnce(new Error(`boom ${ID} ${ME}`));
		const r = await call(check, 'GET', '');
		expect(r.status).toBe(500);
		expect(r.body).toEqual({ message: 'Internal error' });
		const logged = log.mock.calls.flat().join(' ');
		expect(logged).not.toContain(ID);
		expect(logged).not.toContain(ME);
		log.mockRestore();
	});
});

describe('GET /api/v1/cartridges/{id}', () => {
	it('a usable cartridge: assay, analyte, expiry, lot — and nothing else', async () => {
		const r = await call(check, 'GET', '');
		expect(r.status).toBe(200);
		expect(r.body).toEqual({
			cartridgeId: ID,
			usable: true,
			reason: null,
			state: 'ready',
			assay: { id: 'A56E0F5A', name: 'Cortisol - 6.1' },
			analyte: 'cortisol',
			expiresOn: '2027-01-31T00:00:00.000Z',
			lot: { fillLotId: 'fl1', fillLotNumber: 'FL-001', reagentLotId: 'rl1', reagentLotNumber: 'RL-001' }
		});
		expect(JSON.stringify(r.body)).not.toMatch(/Jane|example\.com|cust1|subj1|Calibrator|shipped/);
		expect(state.updates).toHaveLength(0);
		expect(state.audits).toHaveLength(0);
	});

	it('unknown code → 404', async () => {
		state.docs.clear();
		const r = await call(check, 'GET', '');
		expect(r.status).toBe(404);
		expect(r.body).toEqual({ cartridgeId: ID, usable: false, reason: 'not_found' });
	});

	it.each([
		['run data', { rawData: { readings: [1, 2, 3] } }, 'has_results', 'finished'],
		['running', { status: 'underway' }, 'in_use', 'running'],
		['voided', { status: 'voided' }, 'voided', 'unavailable'],
		['research', { experiment: 'EXP-12' }, 'research', 'unavailable'],
		['test fill', { usedForTestFill: true }, 'qc_cartridge', 'unavailable'],
		['no assay', { assayId: '' }, 'no_assay', 'unavailable'],
		['expired', { reagentFilling: { expirationDate: new Date('2020-01-01') } }, 'expired', 'unavailable'],
		['linked by another holder', { status: 'linked', checkpoints: { linked: { who: `app:${OTHER}` } } }, 'linked_by_other', 'linked']
	])('%s → usable false', async (_n, over, reason, st) => {
		Object.assign(state.docs.get(ID), over);
		const r = await call(check, 'GET', '', { query: `?holderRef=${ME}` });
		expect(r.status).toBe(200);
		expect(r.body).toMatchObject({ usable: false, reason, state: st });
		expect(JSON.stringify(r.body)).not.toMatch(/readings|EXP-12/);
	});

	it('a QA/QC release cartridge is refused', async () => {
		state.qcIds.add(ID);
		expect((await call(check, 'GET', '')).body).toMatchObject({ usable: false, reason: 'qc_cartridge' });
	});

	it('linked by the asking holder is usable; without holderRef it is not', async () => {
		Object.assign(state.docs.get(ID), { status: 'linked', checkpoints: { linked: { who: `app:${ME}` } } });
		expect((await call(check, 'GET', '', { query: `?holderRef=${ME}` })).body).toMatchObject({ usable: true, reason: null, state: 'linked' });
		expect((await call(check, 'GET', '')).body).toMatchObject({ usable: false, reason: 'linked_by_other', state: 'linked' });
	});

	it('an invalid holderRef query is 400', async () => {
		expect((await call(check, 'GET', '', { query: '?holderRef=jane@example.com' })).status).toBe(400);
	});
});

describe('POST /api/v1/cartridges/{id}/link', () => {
	it('links: exactly four fields, conditional on the status read and no run data; one audit row', async () => {
		const before = structuredClone(state.docs.get(ID));
		const r = await call(link, 'POST', '/link', { key: BUSINESS });
		expect(r.status).toBe(201);
		expect(r.body).toEqual({ ok: true, status: 'linked', linkedAt: expect.stringMatching(/^\d{4}-.*Z$/) });

		expect(state.updates).toHaveLength(1);
		const { filter, update } = state.updates[0];
		expect(filter).toEqual({ _id: ID, status: 'shipped', rawData: { $exists: false }, reading: { $exists: false }, finalizedAt: null });
		expect(Object.keys(update)).toEqual(['$set']);
		expect(Object.keys(update.$set).sort()).toEqual(['checkpoints.linked', 'priorStatus', 'status', 'statusUpdatedOn']);
		expect(update.$set).toMatchObject({
			status: 'linked',
			priorStatus: 'shipped',
			statusUpdatedOn: r.body.linkedAt,
			'checkpoints.linked': { who: `app:${ME}`, when: r.body.linkedAt, where: {}, via: 'bioscale-business' }
		});

		const after = state.docs.get(ID);
		expect({ ...after, status: before.status, statusUpdatedOn: undefined, priorStatus: undefined, checkpoints: undefined })
			.toEqual({ ...before, statusUpdatedOn: undefined, priorStatus: undefined, checkpoints: undefined });

		expect(state.audits).toHaveLength(1);
		expect(state.audits[0]).toMatchObject({
			tableName: 'cartridge_records', recordId: ID, action: 'LINK', changedBy: 'api:bioscale-business',
			oldData: { status: 'shipped' }, newData: { status: 'linked', holderRef: ME }
		});
		expect(JSON.stringify(state.audits[0])).not.toMatch(/@|Jane|cust1/);
	});

	it('the same holder again → 200 already, no write, no audit row', async () => {
		await call(link, 'POST', '/link');
		const r = await call(link, 'POST', '/link');
		expect(r.status).toBe(200);
		expect(r.body).toEqual({ ok: true, status: 'already' });
		expect(state.updates).toHaveLength(1);
		expect(state.audits).toHaveLength(1);
	});

	it('a link the customer app wrote directly (bare holderRef) is the same holder', async () => {
		Object.assign(state.docs.get(ID), { status: 'linked', priorStatus: 'shipped', checkpoints: { linked: { who: ME } } });
		expect((await call(link, 'POST', '/link')).body).toEqual({ ok: true, status: 'already' });
	});

	it('a different holder → 409 linked_by_other, and the first link stands', async () => {
		await call(link, 'POST', '/link');
		const r = await call(link, 'POST', '/link', { body: { holderRef: OTHER } });
		expect(r.status).toBe(409);
		expect(r.body).toEqual({ ok: false, reason: 'linked_by_other' });
		expect(state.docs.get(ID).checkpoints.linked.who).toBe(`app:${ME}`);
		expect(state.audits).toHaveLength(1);
	});

	it.each([
		['unknown code', null, 404, 'not_found'],
		['run data', { rawData: { readings: [] } }, 409, 'has_results'],
		['used', { used: true }, 409, 'has_results'],
		['running', { status: 'underway' }, 409, 'in_use'],
		['voided', { voidedAt: new Date() }, 409, 'voided'],
		['cancelled', { status: 'cancelled' }, 409, 'unavailable'],
		['research', { experiment: 'EXP-12' }, 409, 'research'],
		['test fill', { usedForTestFill: true }, 409, 'qc_cartridge'],
		['no assay', { assayId: '0' }, 409, 'no_assay'],
		['expired', { reagentFilling: { expirationDate: '2020-01-01' } }, 409, 'expired']
	])('%s → refused, nothing written', async (_n, over, status, reason) => {
		if (over === null) state.docs.clear();
		else Object.assign(state.docs.get(ID), over);
		const r = await call(link, 'POST', '/link');
		expect(r.status).toBe(status);
		expect(r.body).toEqual({ ok: false, reason });
		expect(state.updates).toHaveLength(0);
		expect(state.audits).toHaveLength(0);
	});

	it('a QA/QC release cartridge is refused', async () => {
		state.qcIds.add(ID);
		expect((await call(link, 'POST', '/link')).body).toEqual({ ok: false, reason: 'qc_cartridge' });
	});

	it('status moved between the read and the write: retried once against the new status', async () => {
		state.beforeUpdate = () => { state.docs.get(ID).status = 'released'; };
		const r = await call(link, 'POST', '/link');
		expect(r.status).toBe(201);
		expect(state.updates.map((u) => u.filter.status)).toEqual(['shipped', 'released']);
		expect(state.docs.get(ID)).toMatchObject({ status: 'linked', priorStatus: 'released' });
		expect(state.audits).toHaveLength(1);
	});

	it('a reader started it between the read and the write: never rewound', async () => {
		state.beforeUpdate = () => { Object.assign(state.docs.get(ID), { status: 'underway' }); };
		const r = await call(link, 'POST', '/link');
		expect(r.status).toBe(409);
		expect(r.body).toEqual({ ok: false, reason: 'in_use' });
		expect(state.docs.get(ID).status).toBe('underway');
		expect(state.audits).toHaveLength(0);
	});

	it('run data arrived with the status unchanged: the write does not match', async () => {
		state.beforeUpdate = () => { state.docs.get(ID).rawData = { readings: [1] }; };
		const r = await call(link, 'POST', '/link');
		expect(r.body).toEqual({ ok: false, reason: 'has_results' });
		expect(state.docs.get(ID).status).toBe('shipped');
	});

	it('another holder won the race → linked_by_other', async () => {
		state.beforeUpdate = () => { Object.assign(state.docs.get(ID), { status: 'linked', checkpoints: { linked: { who: `app:${OTHER}` } } }); };
		expect((await call(link, 'POST', '/link')).body).toEqual({ ok: false, reason: 'linked_by_other' });
	});
});

describe('POST /api/v1/cartridges/{id}/unlink', () => {
	it('restores the prior status, clears priorStatus and checkpoints.linked, one audit row; the record is kept', async () => {
		await call(link, 'POST', '/link');
		const r = await call(unlink, 'POST', '/unlink');
		expect(r.status).toBe(200);
		expect(r.body).toEqual({ ok: true, status: 'unlinked', restoredStatus: 'shipped' });

		const { filter, update } = state.updates[1];
		expect(filter).toEqual({ _id: ID, status: 'linked', 'checkpoints.linked.who': `app:${ME}`, rawData: { $exists: false }, reading: { $exists: false }, finalizedAt: null });
		expect(Object.keys(update.$set).sort()).toEqual(['status', 'statusUpdatedOn']);
		expect(update.$unset).toEqual({ priorStatus: '', 'checkpoints.linked': '' });

		const doc = state.docs.get(ID);
		expect(doc.status).toBe('shipped');
		expect(doc.priorStatus).toBeUndefined();
		expect(doc.checkpoints.linked).toBeUndefined();
		expect(doc.reagentFilling.fillLotId).toBe('fl1');
		expect(state.audits[1]).toMatchObject({ action: 'UNLINK', changedBy: 'api:bioscale-app', recordId: ID, newData: { status: 'shipped', holderRef: ME } });
	});

	it('idempotent: a cartridge that is not linked → 200 not_linked, no write', async () => {
		const r = await call(unlink, 'POST', '/unlink');
		expect(r.status).toBe(200);
		expect(r.body).toEqual({ ok: true, status: 'not_linked' });
		expect(state.updates).toHaveLength(0);
		expect(state.audits).toHaveLength(0);
	});

	it.each([
		['unknown code', null, 404, 'not_found'],
		['another holder\'s link', { status: 'linked', priorStatus: 'shipped', checkpoints: { linked: { who: `app:${OTHER}` } } }, 409, 'linked_by_other'],
		['linked with run data', { status: 'linked', checkpoints: { linked: { who: `app:${ME}` } }, rawData: {} }, 409, 'has_results'],
		['running', { status: 'underway', checkpoints: { linked: { who: `app:${ME}` } } }, 409, 'has_results'],
		['completed', { status: 'completed', checkpoints: { linked: { who: `app:${ME}` } } }, 409, 'has_results']
	])('%s → refused, nothing written', async (_n, over, status, reason) => {
		if (over === null) state.docs.clear();
		else Object.assign(state.docs.get(ID), over);
		const r = await call(unlink, 'POST', '/unlink');
		expect(r.status).toBe(status);
		expect(r.body).toEqual({ ok: false, reason });
		expect(state.updates).toHaveLength(0);
	});

	it('a reader started it between the read and the write: left alone', async () => {
		await call(link, 'POST', '/link');
		state.beforeUpdate = () => { state.docs.get(ID).status = 'underway'; };
		const r = await call(unlink, 'POST', '/unlink');
		expect(r.status).toBe(409);
		expect(r.body).toEqual({ ok: false, reason: 'has_results' });
		expect(state.docs.get(ID)).toMatchObject({ status: 'underway', priorStatus: 'shipped' });
	});
});

describe('GET /api/v1/cartridges/{id}/result', () => {
	const linkedBy = (holder: string, over: Record<string, unknown> = {}) =>
		Object.assign(state.docs.get(ID), {
			status: 'linked',
			priorStatus: 'shipped',
			checkpoints: { linked: { who: `app:${holder}`, when: '2026-11-10T14:00:00.000Z' } },
			...over
		});
	const completed = (wells: Record<string, unknown>, over: Record<string, unknown> = {}) => {
		const doc = linkedBy(ME);
		Object.assign(doc, {
			status: 'completed',
			statusUpdatedOn: '2026-11-10T15:02:00.000Z',
			used: true,
			rawData: { readings: [{ channel: 'A', value: 1234 }] },
			device: { id: 'e00fce68aaaa', name: 'reader-0210', firmware_version: 103 },
			experiment: undefined,
			analysis: {
				schemaVersion: 2, engineVersion: '2.6.0', profileId: 'p1', profileName: 'Cortisol 6.1', profileVersion: 7,
				computedAt: '2026-11-10T15:01:45.000Z', quantifiedAt: '2026-11-10T15:01:46.000Z', source: 'lambda', wells
			},
			...over
		});
		doc.checkpoints.underway = { when: '2026-11-10T14:31:02.000Z' };
		doc.checkpoints.completed = { when: '2026-11-10T15:01:40.000Z' };
		return doc;
	};
	const wellA = { qc: { pass: true, flags: [] }, quant: { value: 12.4, unit: 'ng/mL', status: 'ok', curveId: 'c1', curveVersion: 3, curveSource: 'own' }, metrics: { f7_test: 1 } };
	const get = (q = `?holderRef=${ME}`) => call(result, 'GET', '/result', { query: q });

	it('holderRef is required and must be valid', async () => {
		linkedBy(ME);
		expect((await get('')).status).toBe(400);
		expect((await get('?holderRef=jane@example.com')).status).toBe(400);
	});

	it('404 for an unknown code, a cartridge nobody linked, and another holder\'s cartridge — all alike', async () => {
		const notFound = { status: 404, body: { reason: 'not_found' } };
		expect(await get()).toMatchObject(notFound);
		completed({ A: wellA });
		expect(await get(`?holderRef=${OTHER}`)).toMatchObject(notFound);
		state.docs.clear();
		expect(await get()).toMatchObject(notFound);
	});

	it('linked, running and cancelled carry no result', async () => {
		linkedBy(ME);
		expect(await get()).toMatchObject({ status: 200, body: { cartridgeId: ID, state: 'linked', startedAt: null } });

		linkedBy(ME, { status: 'underway' });
		state.docs.get(ID).checkpoints.underway = { when: '2026-11-10T14:31:02Z' };
		const running = await get();
		expect(running.body).toEqual({ cartridgeId: ID, state: 'running', startedAt: '2026-11-10T14:31:02.000Z' });

		state.docs.get(ID).status = 'cancelled';
		expect((await get()).body).toEqual({ cartridgeId: ID, state: 'cancelled', startedAt: '2026-11-10T14:31:02.000Z' });
	});

	it('a completed run the cloud has not analysed yet is still running', async () => {
		completed({ A: wellA }, { analysis: undefined });
		expect((await get()).body).toEqual({ cartridgeId: ID, state: 'running', startedAt: '2026-11-10T14:31:02.000Z', detail: 'analysis_pending' });
		completed({ A: wellA });
		state.docs.get(ID).analysis.schemaVersion = 1;
		expect((await get()).body).toMatchObject({ state: 'running', detail: 'analysis_pending' });
	});

	it('an assay the API does not report never returns a result', async () => {
		completed({ A: wellA }, { assayName: 'CRP - 1.0' });
		expect((await get()).body).toMatchObject({ state: 'running', detail: 'assay_unsupported' });
	});

	it('a link that manufacturing or a void has since overwritten reads as cancelled / not_linked', async () => {
		linkedBy(ME, { status: 'stored' });
		expect((await get()).body).toEqual({ cartridgeId: ID, state: 'cancelled', startedAt: null, detail: 'not_linked' });
	});

	it('completed: the full contract', async () => {
		completed({
			A: wellA,
			B: { qc: { pass: false, flags: [{ key: 'qc:B:high_baseline', message: 'x' }] }, quant: { value: 99, unit: 'ng/mL', status: 'above_range' } },
			C: { qc: { pass: true, flags: [] }, quant: { value: 50, unit: 'ng/mL', status: 'ok' } }
		});
		state.spus = [{ udi: 'BT-0210', particleLink: { particleDeviceId: 'e00fce68aaaa' } }];
		const r = await get();
		expect(r.status).toBe(200);
		expect(r.body).toEqual({
			cartridgeId: ID,
			state: 'completed',
			startedAt: '2026-11-10T14:31:02.000Z',
			completedAt: '2026-11-10T15:01:40.000Z',
			assay: { id: 'A56E0F5A', name: 'Cortisol - 6.1' },
			result: {
				analyte: 'cortisol',
				value: 12.4,
				unit: 'ng/mL',
				status: 'ok',
				reportedWells: ['A'],
				wells: [{ well: 'A', value: 12.4, status: 'ok', qcPass: true, flags: [] }],
				qualityFlags: []
			},
			provenance: {
				fillLotId: 'fl1', fillLotNumber: 'FL-001', reagentLotId: 'rl1', reagentLotNumber: 'RL-001',
				curve: { id: 'c1', version: 3, source: 'own' },
				calculation: {
					engineVersion: '2.6.0', profileId: 'p1', profileName: 'Cortisol 6.1', profileVersion: 7,
					computedAt: '2026-11-10T15:01:45.000Z', quantifiedAt: '2026-11-10T15:01:46.000Z'
				},
				reader: { serial: 'BT-0210', firmwareVersion: '103', opticsCalibrationVersion: null }
			}
		});
		expect(JSON.stringify(r.body)).not.toMatch(/readings|1234|Jane|example\.com|cust1|subj1|Calibrator|e00fce68|reader-0210|f7_test|high_baseline/);
		expect(state.updates).toHaveLength(0);
		expect(state.audits).toHaveLength(0);
	});

	it('completedAt falls back to statusUpdatedOn; provenance is null where nothing is stored', async () => {
		const doc = completed({ A: { qc: { pass: true, flags: [] }, quant: { value: null, unit: '', status: 'no_curve', curveId: null, curveVersion: null } } }, { device: undefined, reagentFilling: undefined });
		delete doc.checkpoints.completed;
		delete doc.checkpoints.underway;
		const r = await get();
		expect(r.body).toMatchObject({
			state: 'completed', startedAt: null, completedAt: '2026-11-10T15:02:00.000Z',
			result: { status: 'not_calibrated', value: null },
			provenance: {
				fillLotId: null, fillLotNumber: null, reagentLotId: null, reagentLotNumber: null,
				curve: { id: null, version: null, source: null },
				reader: { serial: null, firmwareVersion: null, opticsCalibrationVersion: null }
			}
		});
	});

	it('quality flags come back as stored keys, with each well\'s own status', async () => {
		completed({ A: { qc: { pass: false, flags: [{ key: 'qc:A:no_final_read' }, { key: 'qc:A:high_baseline' }] }, quant: { value: null, unit: 'ng/mL', status: 'no_readout' } } });
		const r = await get();
		expect(r.body.result).toMatchObject({
			status: 'qc_fail', value: null,
			wells: [{ well: 'A', value: null, status: 'no_readout', qcPass: false, flags: ['qc:A:no_final_read', 'qc:A:high_baseline'] }],
			qualityFlags: ['qc:A:no_final_read', 'qc:A:high_baseline']
		});
	});

	it('a unit that cannot become ng/mL is unit_unsupported, never relabelled', async () => {
		completed({ A: { ...wellA, quant: { ...wellA.quant, value: 34.2, unit: 'nmol/L' } } });
		const r = await get();
		expect(r.body.result).toMatchObject({ status: 'unit_unsupported', value: null, unit: 'ng/mL', wells: [{ value: null }] });
	});

	it('a stored reader serial is used before the device lookup', async () => {
		completed({ A: wellA }, { testExecution: { spu: { udi: 'BT-0001', firmwareVersion: '101' } }, device: undefined });
		expect((await get()).body.provenance.reader).toEqual({ serial: 'BT-0001', firmwareVersion: '101', opticsCalibrationVersion: null });
	});
});
