/**
 * The /opentrons-clone operator gate cookie (OT2-TAILNET-5 Q4 / S10d): a
 * signed, expiring value bound to the BIMS user. The old constant 'ok' — or
 * anything else hand-set — must never pass.
 */
import { describe, expect, it, vi } from 'vitest';
import {
	OPERATOR_TTL_SECONDS,
	operatorCookieSecret,
	signOperatorCookie,
	verifyOperatorCookie
} from './operator-cookie';

vi.mock('$env/dynamic/private', () => ({ env: { OT_OPERATOR_PASSWORD: 'operator-pw' } }));
vi.mock('$lib/server/db', () => ({
	connectDB: async () => {},
	OpentronsRobot: {
		find: () => ({ select: () => ({ sort: () => ({ lean: async () => [{ _id: 'r1', name: 'OT-2 B14', ip: '10.0.0.5' }] }) }) })
	}
}));

const SECRET = 'test-operator-cookie-secret';
const NOW = 1_790_000_000_000;
const USER = 'u_abc123';

describe('operator cookie', () => {
	it('a freshly signed cookie verifies for the same user', () => {
		const c = signOperatorCookie(SECRET, { userId: USER, now: NOW });
		expect(verifyOperatorCookie(c, SECRET, { userId: USER, now: NOW + 1000 })).toBe(true);
	});

	it("rejects the old constant 'ok' and other hand-set values", () => {
		for (const v of ['ok', 'OK', '', 'v1', 'v1.9999999999999.x.y.z', 'true', '1']) {
			expect(verifyOperatorCookie(v, SECRET, { userId: USER, now: NOW })).toBe(false);
		}
		expect(verifyOperatorCookie(undefined, SECRET, { userId: USER, now: NOW })).toBe(false);
		expect(verifyOperatorCookie(null, SECRET, { userId: USER, now: NOW })).toBe(false);
	});

	it('expires after the TTL (default 8 h)', () => {
		const c = signOperatorCookie(SECRET, { userId: USER, now: NOW });
		const ttlMs = OPERATOR_TTL_SECONDS * 1000;
		expect(verifyOperatorCookie(c, SECRET, { userId: USER, now: NOW + ttlMs - 1 })).toBe(true);
		expect(verifyOperatorCookie(c, SECRET, { userId: USER, now: NOW + ttlMs })).toBe(false);
		const short = signOperatorCookie(SECRET, { userId: USER, now: NOW, ttlSeconds: 60 });
		expect(verifyOperatorCookie(short, SECRET, { userId: USER, now: NOW + 61_000 })).toBe(false);
	});

	it('any tampering breaks the signature: expiry pushed out, user swapped, signature edited', () => {
		const c = signOperatorCookie(SECRET, { userId: USER, now: NOW, ttlSeconds: 60 });
		const [v, exp, uid, nonce, sig] = c.split('.');
		const later = [v, String(Number(exp) + 10 * 24 * 3600 * 1000), uid, nonce, sig].join('.');
		expect(verifyOperatorCookie(later, SECRET, { userId: USER, now: NOW })).toBe(false);
		const other = [v, exp, Buffer.from('u_other').toString('base64url'), nonce, sig].join('.');
		expect(verifyOperatorCookie(other, SECRET, { userId: 'u_other', now: NOW })).toBe(false);
		const flipped = sig.slice(0, -2) + (sig.endsWith('AA') ? 'BB' : 'AA');
		expect(verifyOperatorCookie([v, exp, uid, nonce, flipped].join('.'), SECRET, { userId: USER, now: NOW })).toBe(false);
	});

	it("is bound to the user who logged in — another BIMS user can't reuse it", () => {
		const c = signOperatorCookie(SECRET, { userId: USER, now: NOW });
		expect(verifyOperatorCookie(c, SECRET, { userId: 'u_someone_else', now: NOW })).toBe(false);
	});

	it('a different secret does not verify; no secret verifies nothing', () => {
		const c = signOperatorCookie(SECRET, { userId: USER, now: NOW });
		expect(verifyOperatorCookie(c, 'another-secret', { userId: USER, now: NOW })).toBe(false);
		expect(verifyOperatorCookie(c, null, { userId: USER, now: NOW })).toBe(false);
	});

	it('two logins get different cookies (nonce)', () => {
		const a = signOperatorCookie(SECRET, { userId: USER, now: NOW });
		const b = signOperatorCookie(SECRET, { userId: USER, now: NOW });
		expect(a).not.toBe(b);
	});
});

describe('operatorCookieSecret', () => {
	it('prefers OT_OPERATOR_COOKIE_SECRET', () => {
		expect(operatorCookieSecret({ OT_OPERATOR_COOKIE_SECRET: 's', OT_OPERATOR_PASSWORD: 'p' })).toBe('s');
	});

	it('falls back to a value derived from OT_OPERATOR_PASSWORD (rotating it logs everyone out)', () => {
		const a = operatorCookieSecret({ OT_OPERATOR_PASSWORD: 'p1' });
		const b = operatorCookieSecret({ OT_OPERATOR_PASSWORD: 'p2' });
		expect(a).toBeTruthy();
		expect(a).not.toBe('p1');
		expect(a).not.toBe(b);
		const c = signOperatorCookie(a!, { userId: USER, now: NOW });
		expect(verifyOperatorCookie(c, b, { userId: USER, now: NOW })).toBe(false);
	});

	it('neither set → null (login is disabled, nothing verifies)', () => {
		expect(operatorCookieSecret({})).toBeNull();
	});
});

describe('the /opentrons-clone layout gate', () => {
	const user = { _id: USER, username: 'op', roles: [{ roleId: 'r', roleName: 'Mfg', permissions: ['manufacturing:read'] }] };
	const event = (cookie: string | undefined, pathname = '/opentrons-clone/r1') =>
		({
			locals: { user },
			url: new URL(`https://bims.example${pathname}`),
			cookies: { get: (n: string) => (n === 'ot_operator_auth' ? cookie : undefined) }
		}) as any;

	async function gate(cookie: string | undefined, pathname?: string) {
		const { load } = await import('../../../routes/opentrons-clone/+layout.server');
		try {
			return { data: await (load as any)(event(cookie, pathname)) };
		} catch (e: any) {
			return { thrown: e };
		}
	}

	it("a hand-set ot_operator_auth=ok is sent to the operator login", async () => {
		const r = await gate('ok');
		expect(r.thrown?.status).toBe(303);
		expect(r.thrown?.location).toContain('/opentrons-clone/operator-login');
	});

	it('a cookie signed with the deployment secret for this user passes and gets the robot list', async () => {
		const secret = operatorCookieSecret({ OT_OPERATOR_PASSWORD: 'operator-pw' })!;
		const r = await gate(signOperatorCookie(secret, { userId: USER }));
		expect(r.thrown).toBeUndefined();
		expect(r.data.operatorAuthed).toBe(true);
		expect(r.data.robots).toEqual([{ _id: 'r1', name: 'OT-2 B14', ip: '10.0.0.5' }]);
	});

	it('the login page itself is reachable without the cookie, with no robot list', async () => {
		const r = await gate(undefined, '/opentrons-clone/operator-login');
		expect(r.data.operatorAuthed).toBe(false);
		expect(r.data.robots).toEqual([]);
	});
});
