import { describe, expect, it, vi } from 'vitest';
import { appForKey, requireApp } from './auth';
import { ApiError } from './http';
import { LIMITS, WINDOW_MS, enforceRateLimit, type Counter } from './rate-limit';

vi.mock('mongoose', () => {
	class Schema {
		index() {}
	}
	return { default: { Schema, models: {}, model: () => ({}) } };
});

const CONSUMER = 'consumer-key-0123456789abcdef';
const BUSINESS = 'business-key-0123456789abcdef';
const STORE = 'store-key-0123456789abcdef-xyz';
const vars = { BIMS_API_KEY_CONSUMER: CONSUMER, BIMS_API_KEY_BUSINESS: BUSINESS, BIMS_API_KEY_STORE: STORE };
const req = (headers: Record<string, string>) => new Request('https://bims.test/api/v1/cartridges/x', { headers });

describe('appForKey', () => {
	it('the matched key names the calling app', () => {
		expect(appForKey(CONSUMER, vars)).toBe('bioscale-app');
		expect(appForKey(BUSINESS, vars)).toBe('bioscale-business');
		expect(appForKey(STORE, vars)).toBe('bioscale-store');
	});
	it.each([
		['a wrong key', 'nope-nope-nope-nope-nope-nope'],
		['a prefix of a key', CONSUMER.slice(0, -1)],
		['a key with a suffix', CONSUMER + 'x'],
		['the empty string', '']
	])('%s is refused', (_n, key) => {
		expect(appForKey(key, vars)).toBeNull();
	});
	it('an unset key is never accepted', () => {
		expect(appForKey(BUSINESS, { BIMS_API_KEY_CONSUMER: CONSUMER })).toBeNull();
		expect(appForKey('', { BIMS_API_KEY_CONSUMER: '' })).toBeNull();
		expect(appForKey('undefined', {})).toBeNull();
	});
	it('a key shorter than the minimum is treated as unset', () => {
		expect(appForKey('short', { BIMS_API_KEY_CONSUMER: 'short' })).toBeNull();
	});
	it('the agent, consumer and cron keys are not accepted, even if a v1 variable was set to the same value', () => {
		const shared = 'one-key-used-for-everything-0001';
		for (const foreign of ['AGENT_API_KEY', 'CONSUMER_API_KEY', 'CRON_SECRET']) {
			expect(appForKey(shared, { BIMS_API_KEY_CONSUMER: shared, [foreign]: shared })).toBeNull();
		}
		expect(appForKey('agent-key-agent-key-agent-key', { ...vars, AGENT_API_KEY: 'agent-key-agent-key-agent-key' })).toBeNull();
	});
});

describe('requireApp', () => {
	it('reads Authorization: Bearer', () => {
		expect(requireApp(req({ authorization: `Bearer ${BUSINESS}` }), vars)).toBe('bioscale-business');
	});
	it.each([
		['no header', {}],
		['x-consumer-api-key instead of Authorization', { 'x-consumer-api-key': CONSUMER }],
		['x-agent-api-key instead of Authorization', { 'x-agent-api-key': CONSUMER }],
		['not a Bearer scheme', { authorization: `Basic ${CONSUMER}` }],
		['a bare key', { authorization: CONSUMER }],
		['a wrong key', { authorization: 'Bearer wrong-wrong-wrong-wrong-wrong' }]
	])('%s → 401', (_n, headers) => {
		try {
			requireApp(req(headers as Record<string, string>), vars);
			expect.unreachable();
		} catch (e) {
			expect(e).toBeInstanceOf(ApiError);
			expect((e as ApiError).status).toBe(401);
		}
	});
});

describe('enforceRateLimit', () => {
	const HOLDER = 'h_AAAAAAAAAAAAAAAAAAAAAAAA';
	const memory = () => {
		const counts = new Map<string, number>();
		const counter: Counter = async (key) => {
			counts.set(key, (counts.get(key) ?? 0) + 1);
			return counts.get(key)!;
		};
		return { counts, counter };
	};
	const at = (ms: number) => new Date(Date.UTC(2026, 10, 16, 12, 0, 0) + ms);

	it('allows the per-holder allowance, then answers 429 with Retry-After to the end of the window', async () => {
		const { counter } = memory();
		for (let i = 0; i < LIMITS.link.perHolder; i++) await enforceRateLimit('link', 'bioscale-app', HOLDER, { now: at(15_000), counter });
		const err = await enforceRateLimit('link', 'bioscale-app', HOLDER, { now: at(15_000), counter }).catch((e) => e);
		expect(err).toBeInstanceOf(ApiError);
		expect(err.status).toBe(429);
		expect(err.headers['retry-after']).toBe('45');
	});
	it('a new window starts a new count', async () => {
		const { counter } = memory();
		for (let i = 0; i < LIMITS.link.perHolder; i++) await enforceRateLimit('link', 'bioscale-app', HOLDER, { now: at(0), counter });
		await expect(enforceRateLimit('link', 'bioscale-app', HOLDER, { now: at(WINDOW_MS), counter })).resolves.toBeUndefined();
	});
	it('holders, apps and endpoints are counted apart', async () => {
		const { counter, counts } = memory();
		await enforceRateLimit('link', 'bioscale-app', HOLDER, { now: at(0), counter });
		await enforceRateLimit('link', 'bioscale-business', 'h_BBBBBBBBBBBBBBBBBBBBBBBB', { now: at(0), counter });
		await enforceRateLimit('check', 'bioscale-app', null, { now: at(0), counter });
		expect([...counts.values()]).toEqual([1, 1, 1, 1, 1]);
		expect([...counts.keys()].every((k) => !k.includes('key'))).toBe(true);
	});
	it('the per-app limit applies across holders', async () => {
		const { counter } = memory();
		const holder = (i: number) => `h_${String(i).padStart(24, '0')}`;
		for (let i = 0; i < LIMITS.link.perApp; i++) await enforceRateLimit('link', 'bioscale-app', holder(i), { now: at(0), counter });
		const err = await enforceRateLimit('link', 'bioscale-app', holder(9999), { now: at(0), counter }).catch((e) => e);
		expect(err.status).toBe(429);
	});
	it('fails open when the counter cannot be written', async () => {
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		const broken: Counter = async () => { throw new Error(`db down for ${HOLDER}`); };
		await expect(enforceRateLimit('result', 'bioscale-app', HOLDER, { counter: broken })).resolves.toBeUndefined();
		expect(log.mock.calls.flat().join(' ')).not.toContain(HOLDER);
		log.mockRestore();
	});
});
