import { createHmac } from 'node:crypto';
import { env } from '$env/dynamic/private';

/**
 * BIMS "view as" — a temporary developer door into the consumer app
 * (docs/CONSUMER-OWNERSHIP.md "View as"). An operator with customer:write
 * opens the app as one account; the app shows a read-only session for a real
 * person's account and a normal session for a dev account (accounts.ts).
 *
 * The token is a two-minute HS256 JWT signed with CONSUMER_API_KEY — the
 * secret the two apps already share — so no extra configuration is needed.
 * The app verifies issuer, audience, purpose and expiry
 * (bioscale-app src/lib/server/impersonation.ts). Remove this module together
 * with the app-side door when it is no longer wanted; nothing else uses it.
 */

export const VIEW_AS_TOKEN_TTL_SECONDS = 120;

export function viewAsConfigured(): boolean {
	return Boolean(env.CONSUMER_API_KEY && env.BIOSCALE_APP_URL);
}

const b64url = (input: string | Buffer) => Buffer.from(input).toString('base64url');

export function mintViewAsToken(input: { accountId: string; actor: string }, now = Date.now()): string {
	const secret = env.CONSUMER_API_KEY;
	if (!secret) throw new Error('CONSUMER_API_KEY is not set');
	const iat = Math.floor(now / 1000);
	const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
	const payload = b64url(JSON.stringify({
		iss: 'bims',
		aud: 'bioscale-app',
		purpose: 'view-as',
		sub: input.accountId,
		actor: input.actor,
		iat,
		exp: iat + VIEW_AS_TOKEN_TTL_SECONDS
	}));
	const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
	return `${header}.${payload}.${signature}`;
}

/** Where to send the operator: the app's /auth/impersonate with the token. */
export function viewAsUrl(token: string): string {
	const base = (env.BIOSCALE_APP_URL ?? '').replace(/\/+$/, '');
	return `${base}/auth/impersonate?token=${encodeURIComponent(token)}`;
}
