/**
 * The /opentrons-clone operator-gate cookie (OT2-TAILNET-5 Q4 / S10d).
 *
 * Was the constant 'ok', so anyone who set `ot_operator_auth=ok` passed the
 * gate. Now it is an HMAC-SHA256-signed, expiring value bound to the BIMS user
 * who typed the operator password:
 *
 *   v1.<expiresAtMs>.<base64url(userId)>.<nonce>.<base64url(hmac)>
 *
 * Secret: OT_OPERATOR_COOKIE_SECRET when set; otherwise derived from
 * OT_OPERATOR_PASSWORD (so rotating the password also logs every operator
 * out). Neither set → nothing verifies, which matches login being disabled.
 * The password check itself is unchanged.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const OPERATOR_COOKIE = 'ot_operator_auth';
export const OPERATOR_COOKIE_PATH = '/opentrons-clone';
export const OPERATOR_TTL_SECONDS = 8 * 60 * 60;
const VERSION = 'v1';

const b64u = (b: Buffer) => b.toString('base64url');

export function operatorCookieSecret(env: { OT_OPERATOR_COOKIE_SECRET?: string; OT_OPERATOR_PASSWORD?: string }): string | null {
	if (env.OT_OPERATOR_COOKIE_SECRET) return env.OT_OPERATOR_COOKIE_SECRET;
	if (env.OT_OPERATOR_PASSWORD) return `ot-operator-cookie:v1:${env.OT_OPERATOR_PASSWORD}`;
	return null;
}

function mac(secret: string, payload: string): Buffer {
	return createHmac('sha256', secret).update(payload).digest();
}

export function signOperatorCookie(
	secret: string,
	opts: { userId: string; now?: number; ttlSeconds?: number }
): string {
	const exp = (opts.now ?? Date.now()) + (opts.ttlSeconds ?? OPERATOR_TTL_SECONDS) * 1000;
	const payload = [VERSION, String(exp), b64u(Buffer.from(String(opts.userId), 'utf8')), b64u(randomBytes(9))].join('.');
	return `${payload}.${b64u(mac(secret, payload))}`;
}

/** True only for an unexpired cookie this secret signed for this user. */
export function verifyOperatorCookie(
	value: string | undefined | null,
	secret: string | null,
	opts: { userId: string; now?: number }
): boolean {
	if (!value || !secret) return false;
	const parts = value.split('.');
	if (parts.length !== 5 || parts[0] !== VERSION) return false;
	const [, expRaw, uid, , sig] = parts;
	const payload = parts.slice(0, 4).join('.');
	let given: Buffer;
	try {
		given = Buffer.from(sig, 'base64url');
	} catch {
		return false;
	}
	const want = mac(secret, payload);
	if (given.length !== want.length || !timingSafeEqual(given, want)) return false;
	const exp = Number(expRaw);
	if (!Number.isFinite(exp) || exp <= (opts.now ?? Date.now())) return false;
	return Buffer.from(uid, 'base64url').toString('utf8') === String(opts.userId);
}
