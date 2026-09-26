import { afterEach, describe, expect, it } from 'vitest';
import {
	BRIDGE_TOKEN_TTL_S,
	bridgeJobGate,
	isTailnetLineRequest,
	tailnetLineGate,
	mintBridgeToken,
	parseBridgeKinds,
	signBridgeToken,
	verifyBridgeToken,
	type BridgeTokenClaims
} from './bridge-token';

// Shared test vector — the SAME literal is in scripts/test_ot2_bridge_server.py,
// where the daemon's stdlib verifier accepts it and its signer reproduces it.
const VECTOR_SECRET = 'ot2-bridge-shared-test-vector-secret';
const VECTOR_CLAIMS: BridgeTokenClaims = {
	aud: 'ot2-bridge',
	robotId: 'robot-test-0001',
	deviceId: 'ot2-b99-bridge',
	kinds: ['sweep', 'scan'],
	sub: 'vector-user',
	iat: 1790000000,
	exp: 1790000300,
	jti: 'vector-jti-0001'
};
const VECTOR_TOKEN =
	'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
	'eyJhdWQiOiJvdDItYnJpZGdlIiwicm9ib3RJZCI6InJvYm90LXRlc3QtMDAwMSIsImRldmljZUlkIjoib3QyLWI5OS1icmlkZ2UiLCJr' +
	'aW5kcyI6WyJzd2VlcCIsInNjYW4iXSwic3ViIjoidmVjdG9yLXVzZXIiLCJpYXQiOjE3OTAwMDAwMDAsImV4cCI6MTc5MDAwMDMwMCwi' +
	'anRpIjoidmVjdG9yLWp0aS0wMDAxIn0.' +
	'OCrG02Thi-nfRaIAHmoUsuE_RzXE3cvB3ZvTLTV0Mo4';

const NOW = 1790000100;
const verify = (token: string, o: Partial<Parameters<typeof verifyBridgeToken>[2]> = {}, secret = VECTOR_SECRET) =>
	verifyBridgeToken(token, secret, { deviceId: 'ot2-b99-bridge', nowS: NOW, ...o });

describe('bridge token wire format', () => {
	it('signs the shared vector byte for byte', () => {
		expect(signBridgeToken(VECTOR_CLAIMS, VECTOR_SECRET)).toBe(VECTOR_TOKEN);
	});

	it('header is exactly {"alg":"HS256","typ":"JWT"}', () => {
		const head = VECTOR_TOKEN.split('.')[0];
		expect(Buffer.from(head, 'base64url').toString()).toBe('{"alg":"HS256","typ":"JWT"}');
	});

	it('verifies the vector', () => {
		const r = verify(VECTOR_TOKEN, { kind: 'sweep', robotId: 'robot-test-0001' });
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.claims.kinds).toEqual(['sweep', 'scan']);
		expect(verify(VECTOR_TOKEN).ok).toBe(true); // no kind = health
	});
});

describe('verifyBridgeToken (mirrors the daemon)', () => {
	it('expiry, with the same 30 s leeway', () => {
		expect(verify(VECTOR_TOKEN, { nowS: 1790000300 + 29 }).ok).toBe(true);
		expect(verify(VECTOR_TOKEN, { nowS: 1790000300 + 31 })).toMatchObject({ ok: false, status: 401, error: 'token expired' });
	});

	it('tampered claims or signature → 401', () => {
		const [head, body, sig] = VECTOR_TOKEN.split('.');
		const forgedBody = Buffer.from(JSON.stringify({ ...VECTOR_CLAIMS, kinds: ['restart_robot_server'] })).toString('base64url');
		expect(verify(`${head}.${forgedBody}.${sig}`)).toMatchObject({ ok: false, status: 401 });
		const flipped = sig.slice(0, -2) + (sig.endsWith('AA') ? 'BB' : 'AA');
		expect(verify(`${head}.${body}.${flipped}`)).toMatchObject({ ok: false, status: 401 });
		expect(verify(VECTOR_TOKEN, {}, 'another-secret')).toMatchObject({ ok: false, status: 401 });
		expect(verify('garbage')).toMatchObject({ ok: false, status: 401 });
		expect(verify('')).toMatchObject({ ok: false, status: 401 });
	});

	it('wrong robot → 403, wrong kind → 403', () => {
		expect(verify(VECTOR_TOKEN, { deviceId: 'ot2-b07-bridge' })).toMatchObject({ ok: false, status: 403 });
		expect(verify(VECTOR_TOKEN, { robotId: 'other-robot' })).toMatchObject({ ok: false, status: 403 });
		expect(verify(VECTOR_TOKEN, { kind: 'restart_robot_server' })).toMatchObject({ ok: false, status: 403 });
	});
});

describe('mintBridgeToken', () => {
	it('5-minute TTL, canonical claim order, verifiable', () => {
		const { token, exp, claims } = mintBridgeToken(
			{ robotId: 'r1', deviceId: 'ot2-b14-bridge', kinds: ['deck_scan'], sub: 'alice' },
			's3cret',
			1_800_000_000
		);
		expect(exp).toBe(1_800_000_000 + BRIDGE_TOKEN_TTL_S);
		expect(BRIDGE_TOKEN_TTL_S).toBe(300);
		expect(Object.keys(claims)).toEqual(['aud', 'robotId', 'deviceId', 'kinds', 'sub', 'iat', 'exp', 'jti']);
		expect(
			verifyBridgeToken(token, 's3cret', { deviceId: 'ot2-b14-bridge', kind: 'deck_scan', nowS: 1_800_000_010 }).ok
		).toBe(true);
	});

	it('refuses to sign with no secret', () => {
		expect(() => signBridgeToken(VECTOR_CLAIMS, '')).toThrow();
	});
});

describe('tailnet gates for daemon jobs', () => {
	const b14 = {
		_id: 'robot-b14',
		name: 'Robot 1 B14',
		connection: { mode: 'tailnet', directUrl: 'https://ot2-b14.tailf65a70.ts.net' }
	};
	const saved = { ids: process.env.OT2_TAILNET_ROBOT_IDS, secret: process.env.OT2_BRIDGE_TOKEN_SECRET };
	afterEach(() => {
		for (const [k, v] of [
			['OT2_TAILNET_ROBOT_IDS', saved.ids],
			['OT2_BRIDGE_TOKEN_SECRET', saved.secret]
		] as const) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	});

	it('two keys + secret → open; any one missing → closed with a reason', () => {
		process.env.OT2_TAILNET_ROBOT_IDS = 'b14';
		process.env.OT2_BRIDGE_TOKEN_SECRET = 'x'.repeat(40);
		expect(tailnetLineGate(b14)).toEqual({ ok: true, directUrl: 'https://ot2-b14.tailf65a70.ts.net' });
		expect(bridgeJobGate(b14).ok).toBe(true);

		delete process.env.OT2_BRIDGE_TOKEN_SECRET;
		expect(tailnetLineGate(b14).ok).toBe(true); // the token route answers 503 itself
		expect(bridgeJobGate(b14)).toMatchObject({ ok: false, reason: expect.stringContaining('OT2_BRIDGE_TOKEN_SECRET') });

		process.env.OT2_BRIDGE_TOKEN_SECRET = 'x'.repeat(40);
		process.env.OT2_TAILNET_ROBOT_IDS = 'b07';
		expect(bridgeJobGate(b14).ok).toBe(false); // key 2: not allowed in this deployment
		process.env.OT2_TAILNET_ROBOT_IDS = 'b14';
		expect(bridgeJobGate({ ...b14, connection: { mode: 'queue' } }).ok).toBe(false); // key 1
	});

	it('the tailnet prepare flag is opt-in', () => {
		expect(isTailnetLineRequest({ line: 'tailnet' })).toBe(true);
		expect(isTailnetLineRequest({}, new URL('https://x/api?line=tailnet'))).toBe(true);
		expect(isTailnetLineRequest({ line: 'queue' }, new URL('https://x/api'))).toBe(false);
		expect(isTailnetLineRequest(null, null)).toBe(false);
	});
});

describe('parseBridgeKinds', () => {
	it('validates against the daemon allowlist', () => {
		expect(parseBridgeKinds('sweep, scan,sweep')).toEqual({ kinds: ['sweep', 'scan'], unknown: [] });
		expect(parseBridgeKinds(null)).toEqual({ kinds: [], unknown: [] });
		expect(parseBridgeKinds('http,upload_protocol,deck_scan').unknown).toEqual(['http', 'upload_protocol']);
	});
});
