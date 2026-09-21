/**
 * ARM-02 mode B — contract tests for the stream-url route.
 *
 * The whole point of this endpoint is that it fails SOFTLY. The camera panel
 * has a working snapshot-proxy fallback, so every unhappy path here must come
 * back 200 with `{ available: false }` and let the caller keep polling. A 5xx
 * would turn a cosmetic downgrade into a visible error, which is the bug these
 * tests exist to prevent.
 *
 * No DB, no server: `$env/dynamic/private`, permissions and the Pi client are
 * all mocked. Named `server.test.ts` (not `+server.test.ts`) so SvelteKit's
 * router ignores it while tests/vitest.unit.config.ts's `src/**\/*.test.ts`
 * include still picks it up.
 */
import { describe, it, expect, beforeEach, vi, afterAll } from 'vitest';

// vi.mock factories are hoisted above the imports, so anything they close over
// must be created with vi.hoisted.
const { mockEnv, requirePermission, mintStreamToken } = vi.hoisted(() => ({
	/** Mutable stand-in for SvelteKit's dynamic private env; reset per test. */
	mockEnv: {} as Record<string, string | undefined>,
	requirePermission: vi.fn(),
	mintStreamToken: vi.fn()
}));

vi.mock('$env/dynamic/private', () => ({ env: mockEnv }));

vi.mock('$lib/server/permissions', () => ({ requirePermission }));

vi.mock('$lib/server/robot-arm-client', () => ({ robotArm: { mintStreamToken } }));

import { GET } from './+server';

/** The private values that must never reach the wire. */
const PRIVATE_BASE_URL = 'http://100.64.7.11:8000';
const PRIVATE_API_KEY = 'super-secret-arm-api-key';

const user = { _id: 'u_test', username: 'tester', roles: [] };

/** Minimal event shape — the handler only destructures `locals`. */
function callGET(locals: unknown = { user }) {
	return GET({ locals } as unknown as Parameters<typeof GET>[0]);
}

/** Route logs the mint failure on purpose; keep test output clean. */
const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

beforeEach(() => {
	for (const key of Object.keys(mockEnv)) delete mockEnv[key];
	// Always present in a real deployment — assertions below prove they stay server-side.
	mockEnv.ROBOT_ARM_BASE_URL = PRIVATE_BASE_URL;
	mockEnv.ROBOT_ARM_API_KEY = PRIVATE_API_KEY;
	requirePermission.mockReset();
	mintStreamToken.mockReset();
	consoleError.mockClear();
});

afterAll(() => {
	consoleError.mockRestore();
});

describe('GET /api/robot-arm/cameras/stream-url — auth gate', () => {
	it('throws 401 when there is no session user', async () => {
		await expect(callGET({})).rejects.toMatchObject({ status: 401 });
		expect(mintStreamToken).not.toHaveBeenCalled();
	});

	it('requires manufacturing:read for an authenticated user', async () => {
		mintStreamToken.mockResolvedValue({ stream_token: 't' });
		mockEnv.ROBOT_ARM_PUBLIC_URL = 'https://arm-pi.example.ts.net';

		await callGET();

		expect(requirePermission).toHaveBeenCalledWith(user, 'manufacturing:read');
	});
});

describe('(a) ROBOT_ARM_PUBLIC_URL not configured', () => {
	it('reports unavailable with a reason, at 200, when the var is unset', async () => {
		delete mockEnv.ROBOT_ARM_PUBLIC_URL;

		const res = await callGET();
		const body = await res.json();

		expect(res.status).toBe(200);
		expect(body.available).toBe(false);
		expect(typeof body.reason).toBe('string');
		expect(body.reason.length).toBeGreaterThan(0);
		// No point bothering the Pi when we have no origin to publish.
		expect(mintStreamToken).not.toHaveBeenCalled();
	});

	it('treats a whitespace-only value as unset', async () => {
		mockEnv.ROBOT_ARM_PUBLIC_URL = '   \t ';

		const res = await callGET();
		const body = await res.json();

		expect(res.status).toBe(200);
		expect(body.available).toBe(false);
		expect(body.origin).toBeUndefined();
		expect(body.token).toBeUndefined();
		expect(mintStreamToken).not.toHaveBeenCalled();
	});
});

describe('(b) the Pi errors while minting', () => {
	beforeEach(() => {
		mockEnv.ROBOT_ARM_PUBLIC_URL = 'https://arm-pi.example.ts.net';
	});

	it('degrades to unavailable at 200 — never a 5xx — when mintStreamToken rejects', async () => {
		mintStreamToken.mockRejectedValue(new Error('fetch failed: ECONNREFUSED'));

		const res = await callGET();
		const body = await res.json();

		expect(res.status).toBe(200);
		expect(res.status).toBeLessThan(500);
		expect(body.available).toBe(false);
		expect(typeof body.reason).toBe('string');
	});

	it('does not leak the upstream error text (it can carry the private URL)', async () => {
		mintStreamToken.mockRejectedValue(new Error(`connect ${PRIVATE_BASE_URL} refused`));

		const res = await callGET();
		const text = await res.text();

		expect(text).not.toContain(PRIVATE_BASE_URL);
		expect(text).not.toContain(PRIVATE_API_KEY);
	});

	it('survives a non-Error rejection', async () => {
		mintStreamToken.mockRejectedValue('timeout');

		const res = await callGET();
		const body = await res.json();

		expect(res.status).toBe(200);
		expect(body.available).toBe(false);
	});
});

describe('(c) an older Pi build that returns no stream_token', () => {
	beforeEach(() => {
		mockEnv.ROBOT_ARM_PUBLIC_URL = 'https://arm-pi.example.ts.net';
	});

	it.each([
		['an empty object (cookie-only auth)', {}],
		['an empty-string token', { stream_token: '' }],
		['a null body', null],
		['undefined', undefined]
	])('reports unavailable for %s', async (_label, resolved) => {
		mintStreamToken.mockResolvedValue(resolved);

		const res = await callGET();
		const body = await res.json();

		expect(res.status).toBe(200);
		expect(body.available).toBe(false);
		expect(body.token).toBeUndefined();
	});
});

describe('(d) happy path', () => {
	it('returns origin, token and the default 900s expiry, with a no-store Cache-Control', async () => {
		mockEnv.ROBOT_ARM_PUBLIC_URL = 'https://arm-pi.tailf65a70.ts.net';
		mintStreamToken.mockResolvedValue({ stream_token: 'cam-tok-abc123' });

		const res = await callGET();
		const body = await res.json();

		expect(res.status).toBe(200);
		expect(body).toEqual({
			available: true,
			origin: 'https://arm-pi.tailf65a70.ts.net',
			token: 'cam-tok-abc123',
			// Pi omitted stream_token_expires_in_s — the route supplies the default.
			expiresInS: 900
		});

		// The body is a credential: nothing may keep a copy.
		const cacheControl = res.headers.get('cache-control');
		expect(cacheControl).toBeTruthy();
		expect(cacheControl).toContain('no-store');
	});

	it('honors the Pi-supplied expiry when present', async () => {
		mockEnv.ROBOT_ARM_PUBLIC_URL = 'https://arm-pi.tailf65a70.ts.net';
		mintStreamToken.mockResolvedValue({
			stream_token: 'cam-tok-xyz',
			stream_token_expires_in_s: 120
		});

		const body = await (await callGET()).json();

		expect(body.expiresInS).toBe(120);
	});

	it('strips trailing slashes from the configured public origin', async () => {
		mockEnv.ROBOT_ARM_PUBLIC_URL = 'https://arm-pi.tailf65a70.ts.net///';
		mintStreamToken.mockResolvedValue({ stream_token: 'cam-tok-abc123' });

		const body = await (await callGET()).json();

		expect(body.origin).toBe('https://arm-pi.tailf65a70.ts.net');
	});

	it('publishes only the public origin — never the private URL or the API key', async () => {
		mockEnv.ROBOT_ARM_PUBLIC_URL = 'https://arm-pi.tailf65a70.ts.net';
		mintStreamToken.mockResolvedValue({ stream_token: 'cam-tok-abc123' });

		const text = await (await callGET()).text();

		expect(text).not.toContain(PRIVATE_BASE_URL);
		expect(text).not.toContain(PRIVATE_API_KEY);
		expect(text).toContain('https://arm-pi.tailf65a70.ts.net');
	});
});
